/**
 * Adoptium API (https://api.adoptium.net). The fallback JDK provider: the latest GA Temurin JDK for a
 * feature version on this OS and CPU, used when the JetBrains feed fails.
 */
export interface JdkPackage {
  name: string;
  link: string;
  sha256: string;
  size: number;
  version: string;
}

export type AdoptiumOs = 'windows' | 'mac' | 'linux';
export type AdoptiumArch = 'x64' | 'aarch64';

export function adoptiumOs(platform: NodeJS.Platform): AdoptiumOs {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'mac';
  if (platform === 'linux') return 'linux';
  throw new Error(`unsupported platform ${platform}`);
}

export function adoptiumArch(arch: string): AdoptiumArch {
  if (arch === 'x64') return 'x64';
  if (arch === 'arm64') return 'aarch64';
  throw new Error(`unsupported CPU ${arch}`);
}

export function latestAssetUrl(feature: number, os: AdoptiumOs, arch: AdoptiumArch, base = 'https://api.adoptium.net'): string {
  const q = new URLSearchParams({ architecture: arch, image_type: 'jdk', os, vendor: 'eclipse' });
  return `${base}/v3/assets/latest/${feature}/hotspot?${q}`;
}

/** Picks the package from a /v3/assets/latest response. */
export function parseLatestAssets(json: unknown): JdkPackage {
  if (!Array.isArray(json) || json.length === 0) throw new Error('no JDK build for this platform');
  const first = json[0] as { binary?: { package?: Record<string, unknown> }; version?: { semver?: string } };
  const pkg = first.binary?.package;
  const ok = pkg && typeof pkg.link === 'string' && typeof pkg.checksum === 'string' && typeof pkg.name === 'string';
  if (!ok) throw new Error('unexpected Adoptium response shape');
  return {
    name: pkg.name as string,
    link: pkg.link as string,
    sha256: pkg.checksum as string,
    size: Number(pkg.size) || 0,
    version: first.version?.semver ?? 'unknown',
  };
}
