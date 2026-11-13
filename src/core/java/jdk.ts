import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { JdkRelease } from './catalog';
import { parseSha256 } from './corretto';
import { download, extract, fetchText, findJavaHome, type DownloadOptions } from './download';
import { parseJavaVersion } from './pom';

export interface InstalledJdk {
  home: string;
  feature: number;
  /** Full version from the `release` file, e.g. "17.0.9". */
  version: string;
  /** IMPLEMENTOR from the `release` file, when present. */
  vendor?: string;
  /** Where it was found. */
  origin: 'branch-and-brew' | 'intellij' | 'JAVA_HOME' | 'system';
}

/** Reads JAVA_VERSION and IMPLEMENTOR from a JDK's `release` file. */
export function parseRelease(text: string): { version?: string; vendor?: string } {
  const value = (key: string) => text.match(new RegExp(`^${key}="?([^"\\r\\n]*)"?`, 'm'))?.[1];
  return { version: value('JAVA_VERSION'), vendor: value('IMPLEMENTOR') };
}

/**
 * Version of a JDK home. Normally from its `release` file; some Java 8 builds have none
 * (Amazon Corretto 8 ships `version.txt` instead), and any JDK with `rt.jar` is Java 8 or older.
 */
function readVersion(home: string): { version?: string; vendor?: string } {
  const read = (name: string) => {
    try {
      return readFileSync(path.join(home, name), 'utf8');
    } catch {
      return undefined;
    }
  };
  const release = read('release');
  if (release) return parseRelease(release);
  const text = read('version.txt')?.trim().split(/\s+/)[0];
  if (text && /^\d+(\.\d+)*/.test(text)) return { version: text };
  if (existsSync(path.join(home, 'jre', 'lib', 'rt.jar'))) return { version: '1.8' };
  return {};
}

/** Describes the JDK at `home`, or undefined when it is not one. */
export function inspectJdk(home: string, origin: InstalledJdk['origin'], platform: NodeJS.Platform = process.platform): InstalledJdk | undefined {
  try {
    if (!existsSync(path.join(home, 'bin', platform === 'win32' ? 'java.exe' : 'java'))) return undefined;
    const release = readVersion(home);
    const feature = parseJavaVersion(release.version);
    return feature && release.version ? { home, feature, version: release.version, vendor: release.vendor, origin } : undefined;
  } catch {
    return undefined;
  }
}

export interface DetectOptions {
  /** `<globalStorage>/jdk`: JDKs this extension downloaded. */
  storageDir: string;
  /** The user's home folder; IntelliJ downloads JDKs into `.jdks` there. */
  homeDir: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Install folders to look in instead of the platform's usual ones (tests). */
  systemFolders?: string[];
}

function subfolders(dir: string): string[] {
  try {
    return readdirSync(dir).map((name) => path.join(dir, name)).filter((p) => statSync(p).isDirectory());
  } catch {
    return [];
  }
}

/** Folders where JDK installers usually put them. */
export function commonJdkFolders(platform: NodeJS.Platform, homeDir: string, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'darwin') return ['/Library/Java/JavaVirtualMachines', path.join(homeDir, 'Library', 'Java', 'JavaVirtualMachines')];
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)']].filter((p): p is string => !!p);
    return roots.flatMap((root) => ['Java', 'Eclipse Adoptium', 'Amazon Corretto', 'Zulu', 'Microsoft', 'BellSoft'].map((v) => path.join(root, v)));
  }
  return ['/usr/lib/jvm', '/usr/java'];
}

/**
 * JDKs already on the machine: the ones this extension downloaded, the ones IntelliJ downloaded
 * (`~/.jdks`), JAVA_HOME and the usual install folders. The same home is listed once.
 */
export function detectJdks(options: DetectOptions): InstalledJdk[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const found = new Map<string, InstalledJdk>();
  const add = (dir: string, origin: InstalledJdk['origin']) => {
    let home: string | undefined;
    try {
      home = findJavaHome(dir, platform, 3);
    } catch {
      return;
    }
    const jdk = home && inspectJdk(home, origin, platform);
    const key = home && (platform === 'win32' || platform === 'darwin' ? home.toLowerCase() : home);
    if (jdk && key && !found.has(key)) found.set(key, jdk);
  };
  subfolders(options.storageDir).forEach((dir) => add(dir, 'branch-and-brew'));
  subfolders(path.join(options.homeDir, '.jdks')).forEach((dir) => add(dir, 'intellij'));
  if (env.JAVA_HOME) add(env.JAVA_HOME, 'JAVA_HOME');
  for (const folder of options.systemFolders ?? commonJdkFolders(platform, options.homeDir, env)) subfolders(folder).forEach((dir) => add(dir, 'system'));
  return [...found.values()];
}

const ORIGIN_ORDER: InstalledJdk['origin'][] = ['branch-and-brew', 'intellij', 'JAVA_HOME', 'system'];

/** The JDK to use for a feature version: an exact feature match, the newest build, our own downloads first. */
export function pickJdk(installed: readonly InstalledJdk[], feature: number): InstalledJdk | undefined {
  return installed.filter((j) => j.feature === feature).sort((a, b) =>
    ORIGIN_ORDER.indexOf(a.origin) - ORIGIN_ORDER.indexOf(b.origin)
    || -a.version.localeCompare(b.version, undefined, { numeric: true }))[0];
}

type Network = Pick<DownloadOptions, 'proxy' | 'noProxy' | 'signal' | 'onProgress' | 'allowHttpLocalhost'>;

/**
 * Downloads an archive into `<dir>/<folder>`: download to a temp name, verify, extract beside the
 * target, then rename. A run that was interrupted leaves nothing that looks installed.
 */
export async function installArchive(
  dir: string, folder: string, url: string, checksum: DownloadOptions['checksum'], extension: string, network: Network = {},
): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, folder);
  const archive = path.join(dir, `${folder}.download${extension}`);
  const staging = `${target}.extracting`;
  try {
    await download({ ...network, url, dest: archive, checksum });
    rmSync(staging, { recursive: true, force: true });
    await extract(archive, staging);
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
    return target;
  } finally {
    rmSync(archive, { force: true });
    rmSync(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

/** Downloads and unpacks a JDK under `storageDir`; resolves with its description. */
export async function installJdk(release: JdkRelease, storageDir: string, network: Network = {}): Promise<InstalledJdk> {
  const hex = 'hex' in release.sha256 ? release.sha256.hex : parseSha256(await fetchText(release.sha256.url, network));
  const target = await installArchive(storageDir, release.folder, release.url, { algorithm: 'sha256', hex },
    release.archive === 'zip' ? '.zip' : '.tar.gz', network);
  const home = findJavaHome(target);
  const jdk = home && inspectJdk(home, 'branch-and-brew');
  if (!jdk) {
    rmSync(target, { recursive: true, force: true });
    throw new Error(`the downloaded archive holds no JDK (${release.vendor} ${release.version})`);
  }
  return jdk;
}
