import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { MavenCommand } from '../../core/java/maven';
import type { MavenStatus } from './status';

export const MAVEN_TASK_TYPE = 'branchAndBrew.maven';

export interface MavenRun {
  repo: string;
  /** Shown as the task name, e.g. "Build". */
  label: string;
  command: MavenCommand;
  goals: string[];
  /** JAVA_HOME and PATH for this repository. */
  env: Record<string, string>;
}

interface Ended {
  /** False when VS Code reported the task's process without a process id: it never ran. */
  started: boolean;
  exitCode: number | undefined;
}

/** Runs the task once and resolves when its process has ended. */
async function execute(run: MavenRun, name: string): Promise<Ended> {
  const id = randomUUID();
  const task = new vscode.Task(
    { type: MAVEN_TASK_TYPE, id }, vscode.TaskScope.Workspace, name, 'Maven',
    new vscode.ProcessExecution(run.command.command, [...run.command.args, ...run.goals], { cwd: run.repo, env: run.env }),
    [],
  );
  // The shared task panel: one terminal for all Maven runs, cleared for each.
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, focus: false, panel: vscode.TaskPanelKind.Shared, clear: true };
  const mine = (e: { execution: vscode.TaskExecution }) => e.execution.task.definition.id === id;
  let started = false;
  // Listen before starting: a process that fails at once must not be missed.
  const ended = new Promise<Ended>((resolve) => {
    const subscriptions: vscode.Disposable[] = [];
    const finish = (exitCode: number | undefined) => {
      subscriptions.forEach((s) => s.dispose());
      resolve({ started, exitCode });
    };
    subscriptions.push(
      vscode.tasks.onDidStartTaskProcess((e) => { if (mine(e) && e.processId !== undefined) started = true; }),
      vscode.tasks.onDidEndTaskProcess((e) => { if (mine(e)) finish(e.exitCode); }),
      // A task whose executable could not be started has no process event, it only ends.
      vscode.tasks.onDidEndTask((e) => { if (mine(e)) setTimeout(() => finish(undefined), 500); }),
    );
  });
  await vscode.tasks.executeTask(task);
  return ended;
}

/**
 * Runs Maven as a VS Code task, so the output lands in the terminal panel, and resolves with the
 * exit code (undefined when the task was stopped or could not start). The mark on the repo row
 * follows it.
 */
export async function runMavenTask(status: MavenStatus, run: MavenRun): Promise<number | undefined> {
  const name = `${run.label}: ${path.basename(run.repo)}`;
  status.set(run.repo, 'running');
  let result: Ended;
  try {
    result = await execute(run, name);
    // A task that needs a new terminal can end without ever getting a process (seen on VS Code
    // 1.146 for the first task of a window: no process id, no exit code). Nothing ran, and the
    // terminal exists now, so running it again is safe and works.
    if (!result.started && result.exitCode === undefined) result = await execute(run, name);
  } catch (e) {
    status.set(run.repo, 'failed');
    throw e;
  }
  const { exitCode } = result;
  status.set(run.repo, exitCode === 0 ? 'passed' : 'failed');
  if (exitCode !== 0) {
    const what = exitCode === undefined
      ? (result.started ? 'was stopped' : 'could not be started')
      : `failed with exit code ${exitCode}`;
    void vscode.window.showErrorMessage(`${name} ${what}.`, 'Show Output').then((choice) => {
      if (choice) void vscode.commands.executeCommand('workbench.action.terminal.focus');
    });
  }
  return exitCode;
}
