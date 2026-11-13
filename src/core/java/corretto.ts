/**
 * Amazon Corretto permanent download URLs, as documented in the Corretto user guides
 * ("Downloads for Amazon Corretto", e.g. docs.aws.amazon.com/corretto/latest/corretto-17-ug/downloads-list.html).
 * `latest/` redirects (302) to the current build; `latest_sha256/` returns its SHA-256 as text.
 */
export type CorrettoOs = 'windows' | 'macos' | 'linux';
export type CorrettoArch = 'x64' | 'aarch64';

const BASE = 'https://corretto.aws/downloads';

export function correttoOs(platform: NodeJS.Platform): CorrettoOs {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  throw new Error(`unsupported platform ${platform}`);
}

export function correttoArch(arch: string): CorrettoArch {
  if (arch === 'x64') return 'x64';
  if (arch === 'arm64') return 'aarch64';
  throw new Error(`unsupported CPU ${arch}`);
}

export function correttoFileName(feature: number, os: CorrettoOs, arch: CorrettoArch): string {
  return `amazon-corretto-${feature}-${arch}-${os}-jdk.${os === 'windows' ? 'zip' : 'tar.gz'}`;
}

export function correttoUrls(feature: number, os: CorrettoOs, arch: CorrettoArch): { archive: string; sha256: string } {
  const name = correttoFileName(feature, os, arch);
  return { archive: `${BASE}/latest/${name}`, sha256: `${BASE}/latest_sha256/${name}` };
}

/** The sha256 endpoint returns the bare hex digest; reject anything else (an HTML error page, say). */
export function parseSha256(text: string): string {
  const hex = text.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('unexpected Corretto checksum response');
  return hex;
}
