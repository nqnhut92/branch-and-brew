import { latestAssetUrl, parseLatestAssets, adoptiumArch, adoptiumOs } from './adoptium';
import { correttoArch, correttoOs, correttoUrls } from './corretto';

/** One downloadable JDK build for this OS and CPU. */
export interface JdkRelease {
  /** Shown in the vendor list: "Amazon Corretto", "Eclipse Temurin"… */
  vendor: string;
  /** Feature version: 8, 17… */
  feature: number;
  /** Full version when known ("17.0.21"), otherwise "latest". */
  version: string;
  url: string;
  /** The SHA-256 itself, or where to read it. */
  sha256: { hex: string } | { url: string };
  archive: 'zip' | 'targz';
  /** Folder name under the JDK storage folder. */
  folder: string;
  size?: number;
}

export interface Target {
  platform: NodeJS.Platform;
  arch: string;
}

/** A source of downloadable JDKs. Providers are tried in order until one answers. */
export interface JdkCatalog {
  name: string;
  list(target: Target, fetchJson: (url: string) => Promise<unknown>): Promise<JdkRelease[]>;
}

export const DEFAULT_VENDOR = 'Amazon Corretto';
export const JETBRAINS_FEED_URL = 'https://download.jetbrains.com/jdk/feed/v1/jdks.json';

const FEED_OS: Partial<Record<NodeJS.Platform, string>> = { win32: 'windows', darwin: 'macOS', linux: 'linux' };
const FEED_ARCH: Record<string, string> = { x64: 'x86_64', arm64: 'aarch64' };

interface FeedPackage {
  os?: string; arch?: string; url?: string; package_type?: string; sha256?: string;
  install_folder_name?: string; archive_size?: number;
}
interface FeedJdk {
  vendor?: string; product?: string; flavour?: string; preview?: boolean;
  jdk_version_major?: number; jdk_version?: string; packages?: FeedPackage[];
}

/**
 * Reads the JDK feed IntelliJ uses. It is not a documented API, so anything that does not have
 * the expected shape is skipped, and a feed with nothing usable throws (the next provider is tried).
 * Preview builds and special flavours are left out; Windows prefers the zip package.
 */
export function parseJetBrainsFeed(json: unknown, target: Target): JdkRelease[] {
  const jdks = (json as { jdks?: unknown })?.jdks;
  if (!Array.isArray(jdks)) throw new Error('unexpected JDK feed shape');
  const os = FEED_OS[target.platform];
  const arch = FEED_ARCH[target.arch];
  const releases: JdkRelease[] = [];
  for (const jdk of jdks as FeedJdk[]) {
    if (!jdk || jdk.preview || jdk.flavour || typeof jdk.jdk_version_major !== 'number' || !Array.isArray(jdk.packages)) continue;
    const packages = jdk.packages.filter((p) => p?.os === os && p.arch === arch && typeof p.url === 'string'
      && p.url.startsWith('https://') && /^[0-9a-f]{64}$/i.test(p.sha256 ?? '') && (p.package_type === 'zip' || p.package_type === 'targz'));
    const pkg = packages.find((p) => p.package_type === (target.platform === 'win32' ? 'zip' : 'targz')) ?? packages[0];
    if (!pkg) continue;
    const vendor = [jdk.vendor, jdk.product].filter(Boolean).join(' ').replace(/[™®]/g, '').trim();
    const version = jdk.jdk_version ?? String(jdk.jdk_version_major);
    releases.push({
      vendor, feature: jdk.jdk_version_major, version, url: pkg.url!, sha256: { hex: pkg.sha256!.toLowerCase() },
      archive: pkg.package_type as 'zip' | 'targz',
      folder: safeFolder(pkg.install_folder_name ?? `${vendor}-${version}`), size: pkg.archive_size,
    });
  }
  if (!releases.length) throw new Error('the JDK feed has no build for this platform');
  return releases;
}

/** Folder names come from a remote feed: keep them to one plain path segment. */
export function safeFolder(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'jdk';
}

export function jetBrainsCatalog(feedUrl: string = JETBRAINS_FEED_URL): JdkCatalog {
  return { name: 'JetBrains JDK feed', list: async (target, fetchJson) => parseJetBrainsFeed(await fetchJson(feedUrl), target) };
}

const LTS = [25, 21, 17, 11, 8];

/** Fallback without the feed: the latest Corretto and Temurin builds of the long-term-support versions. */
export function fallbackCatalog(features: readonly number[] = LTS): JdkCatalog {
  return {
    name: 'Corretto and Adoptium',
    list: async (target, fetchJson) => {
      const releases: JdkRelease[] = [];
      const os = correttoOs(target.platform);
      const arch = correttoArch(target.arch);
      for (const feature of features) {
        const urls = correttoUrls(feature, os, arch);
        releases.push({
          vendor: DEFAULT_VENDOR, feature, version: 'latest', url: urls.archive, sha256: { url: urls.sha256 },
          archive: os === 'windows' ? 'zip' : 'targz', folder: `corretto-${feature}`,
        });
      }
      // Temurin through the Adoptium API; a version it does not have for this platform is skipped.
      await Promise.all(features.map(async (feature) => {
        try {
          const pkg = parseLatestAssets(await fetchJson(latestAssetUrl(feature, adoptiumOs(target.platform), adoptiumArch(target.arch))));
          releases.push({
            vendor: 'Eclipse Temurin', feature, version: pkg.version, url: pkg.link, sha256: { hex: pkg.sha256 },
            archive: pkg.name.endsWith('.zip') ? 'zip' : 'targz', folder: safeFolder(`temurin-${pkg.version}`), size: pkg.size,
          });
        } catch {
          // No build, or the API is unreachable: Corretto is still offered.
        }
      }));
      return releases;
    },
  };
}

/** The first provider that answers. Rejects with every provider's error when none does. */
export async function loadCatalog(
  providers: readonly JdkCatalog[], target: Target, fetchJson: (url: string) => Promise<unknown>,
): Promise<{ source: string; releases: JdkRelease[] }> {
  const errors: string[] = [];
  for (const provider of providers) {
    try {
      return { source: provider.name, releases: await provider.list(target, fetchJson) };
    } catch (e) {
      errors.push(`${provider.name}: ${(e as Error).message}`);
    }
  }
  throw new Error(`No JDK catalogue could be loaded (${errors.join('; ')})`);
}

/** Feature versions on offer, newest first. */
export function featuresOf(releases: readonly JdkRelease[]): number[] {
  return [...new Set(releases.map((r) => r.feature))].sort((a, b) => b - a);
}

/** Compares dotted versions number by number; "1.8.0_512" sorts as 1.8.0.512. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[^0-9]+/).filter(Boolean).map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** The newest build of each vendor for one feature version: the default vendor first, then by name. */
export function vendorsFor(releases: readonly JdkRelease[], feature: number, preferred = DEFAULT_VENDOR): JdkRelease[] {
  const newest = new Map<string, JdkRelease>();
  for (const r of releases) {
    if (r.feature !== feature) continue;
    const have = newest.get(r.vendor);
    if (!have || compareVersions(r.version, have.version) > 0) newest.set(r.vendor, r);
  }
  return [...newest.values()].sort((a, b) =>
    Number(b.vendor === preferred) - Number(a.vendor === preferred) || a.vendor.localeCompare(b.vendor));
}
