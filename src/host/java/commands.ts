import * as path from 'node:path';
import * as vscode from 'vscode';
import type { InstalledJdk } from '../../core/java/jdk';
import { mavenGoals, moduleArgs, splitGoals, type MavenAction } from '../../core/java/maven';
import { readModules } from '../../core/java/pom';
import { repoName, type Deps } from '../repos/commands';
import type { RepoNode } from '../repos/treeProvider';
import type { MavenStatus } from '../maven/status';
import { runMavenTask } from '../maven/tasks';
import { jdkLabel, type Toolchain } from './toolchain';

const LABEL: Record<MavenAction, string> = { build: 'Build', buildSkipTests: 'Build Skipping Tests', test: 'Run Tests' };

const COMMON_FEATURES = [8, 11, 17, 21, 25];

/**
 * The JDK for a repository. Asks once which Java version it needs when the pom does not say, and
 * offers the download dialog when that version is not installed. Never downloads on its own.
 */
export async function ensureJava(java: Toolchain, repo: string): Promise<InstalledJdk | undefined> {
  let resolution = java.resolve(repo);
  if (resolution.state === 'unknown') {
    const installed = [...new Set(java.installedJdks().map((j) => j.feature))];
    const features = [...new Set([...installed, ...COMMON_FEATURES])].sort((a, b) => b - a);
    const pick = await vscode.window.showQuickPick(
      features.map((f) => ({ label: `Java ${f}`, description: installed.includes(f) ? 'installed' : undefined, feature: f })),
      { title: `Which Java version does ${repoName(repo)} need?`, placeHolder: 'Its pom.xml does not say. The answer is remembered for this repository.' });
    if (!pick) return undefined;
    await java.setChoice(repo, { feature: pick.feature });
    resolution = java.resolve(repo);
  }
  if (resolution.jdk) return resolution.jdk;
  const feature = resolution.feature!;
  const choice = await vscode.window.showWarningMessage(
    `${repoName(repo)} needs Java ${feature}, and no Java ${feature} JDK is installed.`, 'Download JDK…');
  if (!choice) return undefined;
  const jdk = await java.downloadJdk(feature);
  return jdk?.feature === feature ? jdk : java.resolve(repo).jdk;
}

/** How to start Maven in a repository; offers the download dialog when there is neither a wrapper nor a Maven. */
async function ensureMaven(java: Toolchain, repo: string) {
  const command = java.mavenCommand(repo);
  if (command) return command;
  const choice = await vscode.window.showWarningMessage(
    `${repoName(repo)} has no Maven wrapper, and no Maven is installed.`, 'Download Maven…');
  if (!choice || !await java.downloadMaven()) return undefined;
  return java.mavenCommand(repo);
}

/** Runs Maven goals in a repository with its own JDK. Resolves with the exit code, or undefined when nothing ran. */
export async function runMaven(java: Toolchain, status: MavenStatus, repo: string, label: string, goals: string[]): Promise<number | undefined> {
  if (!await ensureJava(java, repo)) return undefined;
  const command = await ensureMaven(java, repo);
  if (!command) return undefined;
  return runMavenTask(status, { repo, label, command, goals, env: java.env(repo) });
}

/** Lines of the Show Toolchain summary for one repository. */
export function describeToolchain(java: Toolchain, repo: string): string[] {
  const r = java.resolve(repo);
  const command = java.mavenCommand(repo);
  const maven = java.maven();
  return [
    r.feature ? `Java needed: ${r.feature} (${r.source})` : 'Java needed: not stated in pom.xml',
    r.jdk ? `JDK: ${jdkLabel(r.jdk)} at ${r.jdk.home}` : r.feature ? `JDK: no Java ${r.feature} installed` : 'JDK: none selected',
    command?.kind === 'wrapper' ? 'Maven: the repository\'s wrapper (mvnw)' : maven ? `Maven: ${maven.version} at ${maven.home}` : 'Maven: none installed',
  ];
}

export function registerJavaCommands(deps: Deps, java: Toolchain, status: MavenStatus): vscode.Disposable[] {
  const reg = (id: string, fn: (...args: never[]) => unknown) => vscode.commands.registerCommand(`branchAndBrew.${id}`, fn);
  const failed = (e: unknown) => void vscode.window.showErrorMessage((e as Error).message);

  /** A Maven repository from a tree node, or asked for. */
  const repoArg = async (node?: RepoNode): Promise<string | undefined> => {
    if (node?.kind === 'repo') return node.path;
    const repos = deps.store.list.repos.map((r) => r.path).filter((r) => deps.projectKinds?.(r).includes('maven'));
    if (!repos.length) return void vscode.window.showInformationMessage('No registered repository has a pom.xml.');
    return (await vscode.window.showQuickPick(repos.map((r) => ({ label: repoName(r), description: r, repo: r })), { title: 'Repository' }))?.repo;
  };

  const action = (kind: MavenAction) => async (node?: RepoNode) => {
    const repo = await repoArg(node);
    return repo ? runMaven(java, status, repo, LABEL[kind], mavenGoals(kind)).catch(failed) : undefined;
  };

  return [
    reg('installJdk', () => java.downloadJdk().catch(failed)),
    reg('installMaven', () => java.downloadMaven().catch(failed)),
    reg('maven.build', action('build')),
    reg('maven.buildSkipTests', action('buildSkipTests')),
    reg('maven.test', action('test')),

    reg('maven.buildModule', async (node?: RepoNode) => {
      const repo = await repoArg(node);
      if (!repo) return undefined;
      const modules = readModules(path.join(repo, 'pom.xml'));
      if (!modules.length) return void vscode.window.showInformationMessage(`${repoName(repo)} has no modules in its pom.xml.`);
      const module = await vscode.window.showQuickPick(modules, { title: `Build one module of ${repoName(repo)}`, placeHolder: 'Built with the modules it depends on (-pl <module> -am)' });
      return module ? runMaven(java, status, repo, `Build ${module}`, [...mavenGoals('build'), ...moduleArgs(module)]).catch(failed) : undefined;
    }),

    reg('maven.custom', async (node?: RepoNode) => {
      const repo = await repoArg(node);
      if (!repo) return undefined;
      const history = java.goalHistory();
      const NEW = '$(edit) Type goals…';
      const pick = history.length
        ? await vscode.window.showQuickPick([NEW, ...history], { title: `Maven goals for ${repoName(repo)}`, placeHolder: 'The last 10 are remembered' })
        : NEW;
      if (!pick) return undefined;
      const text = pick === NEW
        ? await vscode.window.showInputBox({ title: `Maven goals for ${repoName(repo)}`, placeHolder: 'clean verify -P profile -DskipTests' })
        : pick;
      if (!text?.trim()) return undefined;
      await java.rememberGoals(text);
      return runMaven(java, status, repo, 'Maven', splitGoals(text)).catch(failed);
    }),

    reg('javaVersion', async (node?: RepoNode) => {
      const repo = await repoArg(node);
      if (!repo) return;
      const current = java.resolve(repo);
      type Item = vscode.QuickPickItem & { run(): Promise<unknown> };
      const items: Item[] = [
        { label: 'Automatic', description: 'From pom.xml', detail: current.feature ? `Java ${current.feature} (${current.source})` : undefined,
          run: () => java.setChoice(repo, { feature: java.choice(repo)?.feature }) },
        ...java.installedJdks().sort((a, b) => b.feature - a.feature).map((j): Item => ({
          label: jdkLabel(j), description: j.origin === 'intellij' ? 'downloaded by IntelliJ' : j.origin === 'branch-and-brew' ? 'downloaded here' : j.origin,
          detail: j.home, run: () => java.setChoice(repo, { ...java.choice(repo), home: j.home }),
        })),
        { label: '$(cloud-download) Download JDK…', run: async () => {
          const jdk = await java.downloadJdk(current.feature);
          if (jdk) await java.setChoice(repo, { ...java.choice(repo), home: jdk.home });
        } },
      ];
      const pick = await vscode.window.showQuickPick(items, {
        title: `Java for ${repoName(repo)}`, placeHolder: current.jdk ? `Now: ${jdkLabel(current.jdk)}` : 'Now: no JDK selected', matchOnDetail: true,
      });
      await pick?.run().catch(failed);
    }),

    reg('showToolchain', async (node?: RepoNode) => {
      const repo = await repoArg(node);
      if (!repo) return undefined;
      java.refresh();
      const lines = describeToolchain(java, repo);
      void vscode.window.showQuickPick(lines, { title: `Toolchain of ${repoName(repo)}`, placeHolder: 'Java Version… changes the JDK; Install JDK… and Install Maven… download more' });
      return lines;
    }),
  ];
}
