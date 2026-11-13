import { homedir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  DEFAULT_VENDOR, fallbackCatalog, featuresOf, jetBrainsCatalog, loadCatalog, vendorsFor, JETBRAINS_FEED_URL, type JdkRelease,
} from '../../core/java/catalog';
import { fetchJson, fetchText, resolveProxy, type DownloadOptions } from '../../core/java/download';
import { detectJdks, installJdk, type DetectOptions, type InstalledJdk } from '../../core/java/jdk';
import {
  MAVEN_METADATA_URL, installMaven, installedMavens, mavenCommand, parseMavenVersions, rememberGoals, toolchainEnv,
  type InstalledMaven, type MavenCommand,
} from '../../core/java/maven';
import { resolveJava, type JavaChoice, type JavaResolution } from '../../core/java/toolchain';
import { pathKey } from '../../core/repos/model';

const CHOICES_KEY = 'branchAndBrew.javaChoices';
const MAVEN_KEY = 'branchAndBrew.mavenVersion';
const GOALS_KEY = 'branchAndBrew.mavenGoals';

/** Replaced by the integration tests: where things are stored and which servers are asked. */
export interface ToolchainOverrides {
  jdkDir?: string;
  mavenDir?: string;
  detect?: Partial<DetectOptions>;
  feedUrl?: string;
  mavenMetadataUrl?: string;
  mavenBase?: string;
  allowHttpLocalhost?: boolean;
}

const jdkLabel = (j: InstalledJdk) => `Java ${j.feature} (${j.version}${j.vendor ? `, ${j.vendor}` : ''})`;
export { jdkLabel };

/**
 * The JDKs and Maven versions on this machine and which one each repository uses. Downloads go
 * under the extension's global storage; nothing is ever downloaded without the user asking.
 */
export class Toolchain implements vscode.Disposable {
  overrides: ToolchainOverrides = {};
  private cache?: InstalledJdk[];
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when a JDK or Maven was installed or a repository's choice changed. */
  readonly onDidChange = this.changed.event;

  constructor(private readonly context: Pick<vscode.ExtensionContext, 'globalState' | 'globalStorageUri'>) {}

  get jdkDir(): string {
    return this.overrides.jdkDir ?? vscode.Uri.joinPath(this.context.globalStorageUri, 'jdk').fsPath;
  }

  get mavenDir(): string {
    return this.overrides.mavenDir ?? vscode.Uri.joinPath(this.context.globalStorageUri, 'maven').fsPath;
  }

  /** Forgets what was detected; the next question looks at the disk again. */
  refresh(): void {
    this.cache = undefined;
    this.changed.fire();
  }

  installedJdks(): InstalledJdk[] {
    this.cache ??= detectJdks({ storageDir: this.jdkDir, homeDir: homedir(), ...this.overrides.detect });
    return this.cache;
  }

  private choices(): Record<string, JavaChoice> {
    return this.context.globalState.get<Record<string, JavaChoice>>(CHOICES_KEY) ?? {};
  }

  choice(repo: string): JavaChoice | undefined {
    return this.choices()[pathKey(repo)];
  }

  async setChoice(repo: string, choice: JavaChoice | undefined): Promise<void> {
    const all = { ...this.choices() };
    if (choice && (choice.home || choice.feature)) all[pathKey(repo)] = choice;
    else delete all[pathKey(repo)];
    await this.context.globalState.update(CHOICES_KEY, all);
    this.changed.fire();
  }

  resolve(repo: string): JavaResolution {
    return resolveJava(repo, this.choice(repo), this.installedJdks());
  }

  installedMavens(): InstalledMaven[] {
    return installedMavens(this.mavenDir);
  }

  /** The Maven version used when a repository has no wrapper: the chosen one, else the newest installed. */
  maven(): InstalledMaven | undefined {
    const all = this.installedMavens();
    const chosen = this.context.globalState.get<string>(MAVEN_KEY);
    return all.find((m) => m.version === chosen) ?? all[0];
  }

  mavenCommand(repo: string): MavenCommand | undefined {
    return mavenCommand(repo, this.maven()?.home);
  }

  /** JAVA_HOME and PATH for Maven and for terminals opened on the repository. */
  env(repo: string): Record<string, string> {
    return toolchainEnv(this.resolve(repo).jdk?.home, this.maven()?.home);
  }

  goalHistory(): string[] {
    return this.context.globalState.get<string[]>(GOALS_KEY) ?? [];
  }

  async rememberGoals(text: string): Promise<void> {
    await this.context.globalState.update(GOALS_KEY, rememberGoals(this.goalHistory(), text));
  }

  private network(signal?: AbortSignal): Pick<DownloadOptions, 'proxy' | 'noProxy' | 'signal' | 'allowHttpLocalhost'> {
    const http = vscode.workspace.getConfiguration('http');
    const noProxy = [...(http.get<string[]>('noProxy') ?? []), process.env.NO_PROXY ?? process.env.no_proxy ?? ''].filter(Boolean).join(',');
    return { proxy: resolveProxy(http.get<string>('proxy')), noProxy, signal, allowHttpLocalhost: this.overrides.allowHttpLocalhost };
  }

  /** Downloadable JDKs: the JetBrains feed (URL from the setting), else Corretto and Adoptium. */
  async catalog(): Promise<{ source: string; releases: JdkRelease[] }> {
    const setting = vscode.workspace.getConfiguration('branchAndBrew').get<string>('java.jdkFeedUrl')?.trim();
    const feedUrl = this.overrides.feedUrl ?? (setting || JETBRAINS_FEED_URL);
    const network = this.network();
    return loadCatalog([jetBrainsCatalog(feedUrl), fallbackCatalog()], { platform: process.platform, arch: process.arch },
      (url) => fetchJson(url, network));
  }

  private withProgress<T>(title: string, work: (network: Parameters<typeof installJdk>[2]) => Promise<T>): Thenable<T> {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (progress, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());
      let reported = 0;
      return work({
        ...this.network(abort.signal),
        onProgress: (received, total) => {
          const mb = `${Math.round(received / 1e6)} MB`;
          if (!total) return progress.report({ message: mb });
          const percent = Math.floor((received / total) * 100);
          if (percent > reported) {
            progress.report({ increment: percent - reported, message: `${mb} of ${Math.round(total / 1e6)} MB` });
            reported = percent;
          }
        },
      });
    });
  }

  /** Downloads one JDK build with a progress notification. */
  async installRelease(release: JdkRelease): Promise<InstalledJdk> {
    const jdk = await this.withProgress(`Downloading ${release.vendor} ${release.feature}`, (network) => installJdk(release, this.jdkDir, network));
    this.refresh();
    return jdk;
  }

  async mavenVersions(): Promise<string[]> {
    return parseMavenVersions(await fetchText(this.overrides.mavenMetadataUrl ?? MAVEN_METADATA_URL, this.network()));
  }

  async installMavenVersion(version: string): Promise<InstalledMaven> {
    const maven = await this.withProgress(`Downloading Maven ${version}`, (network) => installMaven(version, this.mavenDir, network, this.overrides.mavenBase));
    await this.context.globalState.update(MAVEN_KEY, version);
    this.changed.fire();
    return maven;
  }

  /**
   * The Download JDK dialog: pick a version, then a vendor, then download. `feature` preselects
   * the version. Undefined when the user backs out.
   */
  async downloadJdk(feature?: number): Promise<InstalledJdk | undefined> {
    const { source, releases } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Loading the list of JDKs' }, () => this.catalog());
    const features = featuresOf(releases);
    const version = await vscode.window.showQuickPick(
      features
        .sort((a, b) => Number(b === feature) - Number(a === feature))
        .map((f) => ({ label: `Java ${f}`, description: f === feature ? 'needed by this repository' : undefined, feature: f })),
      { title: 'Download JDK (1/2): version', placeHolder: `From: ${source}` });
    if (!version) return undefined;
    const vendor = await vscode.window.showQuickPick(
      vendorsFor(releases, version.feature).map((r) => ({
        label: r.vendor, description: [r.version, r.size ? `${Math.round(r.size / 1e6)} MB` : '', r.vendor === DEFAULT_VENDOR ? 'default' : ''].filter(Boolean).join(' · '),
        detail: `Installs into ${path.join(this.jdkDir, r.folder)}`, release: r,
      })),
      { title: `Download JDK (2/2): vendor for Java ${version.feature}`, matchOnDescription: true });
    return vendor ? this.installRelease(vendor.release) : undefined;
  }

  /** The Download Maven dialog: pick a version, then download. */
  async downloadMaven(): Promise<InstalledMaven | undefined> {
    const versions = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Loading the list of Maven versions' }, () => this.mavenVersions());
    const installed = new Set(this.installedMavens().map((m) => m.version));
    const pick = await vscode.window.showQuickPick(
      versions.map((v, i) => ({ label: v, description: [i === 0 ? 'latest' : '', installed.has(v) ? 'installed' : ''].filter(Boolean).join(' · ') })),
      { title: 'Download Maven: version', placeHolder: `Installs into ${this.mavenDir}` });
    return pick ? this.installMavenVersion(pick.label) : undefined;
  }

  dispose(): void {
    this.changed.dispose();
  }
}
