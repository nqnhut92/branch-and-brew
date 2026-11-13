import { existsSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { compareVersions } from './catalog';
import { fetchText, type DownloadOptions } from './download';
import { installArchive } from './jdk';
import { children, at, parseXml } from './xml';

export const MAVEN_METADATA_URL = 'https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/maven-metadata.xml';
const ARCHIVE = 'https://archive.apache.org/dist/maven';

/** Stable Maven 3 releases from Maven Central's metadata, newest first (3.0.4+ is what the archive holds). */
export function parseMavenVersions(metadataXml: string): string[] {
  const versions = children(at(parseXml(metadataXml), 'metadata', 'versioning', 'versions'), 'version').map((v) => v.text);
  return versions.filter((v) => /^3\.\d+\.\d+$/.test(v) && compareVersions(v, '3.0.4') >= 0).sort((a, b) => compareVersions(b, a));
}

/** Apache archive layout: `maven-3/<v>/binaries/apache-maven-<v>-bin.zip|tar.gz`, with a `.sha512` beside it. */
export function mavenUrls(version: string, platform: NodeJS.Platform = process.platform, base = ARCHIVE): { archive: string; sha512: string; extension: string } {
  const extension = platform === 'win32' ? '.zip' : '.tar.gz';
  const archive = `${base}/maven-${version.split('.')[0]}/${version}/binaries/apache-maven-${version}-bin${extension}`;
  return { archive, sha512: `${archive}.sha512`, extension };
}

/** The `.sha512` file holds the hex digest, sometimes followed by the file name. */
export function parseSha512(text: string): string {
  const hex = text.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (!/^[0-9a-f]{128}$/.test(hex)) throw new Error('unexpected Maven checksum response');
  return hex;
}

type Network = Pick<DownloadOptions, 'proxy' | 'noProxy' | 'signal' | 'onProgress' | 'allowHttpLocalhost'>;

export interface InstalledMaven {
  home: string;
  version: string;
}

/** The Maven home inside `<storageDir>/<version>`: the folder whose bin/ holds mvn. */
function mavenHomeIn(dir: string): string | undefined {
  const has = (d: string) => existsSync(path.join(d, 'bin', 'mvn')) || existsSync(path.join(d, 'bin', 'mvn.cmd'));
  if (has(dir)) return dir;
  try {
    return readdirSync(dir).map((n) => path.join(dir, n)).find((d) => statSync(d).isDirectory() && has(d));
  } catch {
    return undefined;
  }
}

/** Maven versions downloaded into `storageDir`, newest first. */
export function installedMavens(storageDir: string): InstalledMaven[] {
  let names: string[] = [];
  try {
    names = readdirSync(storageDir);
  } catch {
    return [];
  }
  return names
    .map((version) => ({ version, home: mavenHomeIn(path.join(storageDir, version)) }))
    .filter((m): m is InstalledMaven => !!m.home && /^\d+\.\d+/.test(m.version))
    .sort((a, b) => compareVersions(b.version, a.version));
}

export async function installMaven(version: string, storageDir: string, network: Network = {}, base?: string): Promise<InstalledMaven> {
  const urls = mavenUrls(version, process.platform, base);
  const hex = parseSha512(await fetchText(urls.sha512, network));
  const target = await installArchive(storageDir, version, urls.archive, { algorithm: 'sha512', hex }, urls.extension, network);
  const home = mavenHomeIn(target);
  if (!home) throw new Error(`the downloaded archive holds no Maven (${version})`);
  return { home, version };
}

export type MavenAction = 'build' | 'buildSkipTests' | 'test';

const GOALS: Record<MavenAction, string[]> = {
  build: ['clean', 'install'],
  buildSkipTests: ['clean', 'install', '-DskipTests'],
  test: ['test'],
};

export const mavenGoals = (action: MavenAction): string[] => [...GOALS[action]];

/** Splits what the user typed for Custom Goals; double quotes keep an argument with spaces together. */
export function splitGoals(text: string): string[] {
  return (text.match(/(?:"[^"]*"|[^\s"])+/g) ?? []).map((part) => part.replace(/"/g, ''));
}

/** Builds one module and what it depends on: `-pl <module> -am`. */
export const moduleArgs = (module: string | undefined): string[] => (module ? ['-pl', module.replace(/\\/g, '/'), '-am'] : []);

/** Adds `text` to the front of the remembered goals, without duplicates, keeping at most `max`. */
export function rememberGoals(history: readonly string[], text: string, max = 10): string[] {
  const trimmed = text.trim();
  return trimmed ? [trimmed, ...history.filter((h) => h !== trimmed)].slice(0, max) : [...history];
}

export interface MavenCommand {
  /** Executable to start. */
  command: string;
  /** Arguments that come before the goals. */
  args: string[];
  /** `wrapper` when the repository's own mvnw is used. */
  kind: 'wrapper' | 'maven';
}

/**
 * How to start Maven in a repository: its wrapper when it has one, else the given Maven home.
 * On Windows both are batch files, which only cmd.exe can run. On other systems the wrapper goes
 * through sh, so it works without its executable bit.
 */
export function mavenCommand(repo: string, mavenHome: string | undefined, platform: NodeJS.Platform = process.platform): MavenCommand | undefined {
  const windows = platform === 'win32';
  const wrapper = path.join(repo, windows ? 'mvnw.cmd' : 'mvnw');
  if (existsSync(wrapper)) {
    return windows ? { command: 'cmd.exe', args: ['/d', '/c', wrapper], kind: 'wrapper' } : { command: 'sh', args: [wrapper], kind: 'wrapper' };
  }
  if (!mavenHome) return undefined;
  const mvn = path.join(mavenHome, 'bin', windows ? 'mvn.cmd' : 'mvn');
  return windows ? { command: 'cmd.exe', args: ['/d', '/c', mvn], kind: 'maven' } : { command: mvn, args: [], kind: 'maven' };
}

/** Environment for Maven and for terminals: JAVA_HOME, and the JDK and Maven in front of PATH. */
export function toolchainEnv(
  javaHome: string | undefined, mavenHome: string | undefined, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const result: Record<string, string> = {};
  const dirs = [javaHome && path.join(javaHome, 'bin'), mavenHome && path.join(mavenHome, 'bin')].filter((d): d is string => !!d);
  if (javaHome) result.JAVA_HOME = javaHome;
  if (mavenHome) result.MAVEN_HOME = mavenHome;
  if (dirs.length) {
    // Windows names the variable "Path"; setting "PATH" as well would create a second one.
    const key = platform === 'win32' ? Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'Path' : 'PATH';
    result[key] = [...dirs, env[key] ?? ''].filter(Boolean).join(platform === 'win32' ? ';' : ':');
  }
  return result;
}
