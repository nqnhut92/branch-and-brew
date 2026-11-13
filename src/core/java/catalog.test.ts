import { describe, expect, it } from 'vitest';
import {
  compareVersions, fallbackCatalog, featuresOf, jetBrainsCatalog, loadCatalog, parseJetBrainsFeed, safeFolder, vendorsFor,
} from './catalog';

const sha = 'a'.repeat(64);
const pkg = (os: string, arch: string, type: string, name: string) => ({
  os, arch, url: `https://example.invalid/${name}`, package_type: type, sha256: sha, install_folder_name: name, archive_size: 10,
});
// The shape of download.jetbrains.com/jdk/feed/v1/jdks.json, cut down to what is read.
const feed = {
  jdks: [
    { vendor: 'Amazon', product: 'Corretto', jdk_version_major: 17, jdk_version: '17.0.21',
      packages: [pkg('macOS', 'aarch64', 'targz', 'corretto-17.0.21'), pkg('windows', 'x86_64', 'targz', 'corretto-17.0.21'), pkg('windows', 'x86_64', 'zip', 'corretto-17.0.21')] },
    { vendor: 'Amazon', product: 'Corretto', jdk_version_major: 17, jdk_version: '17.0.9', packages: [pkg('macOS', 'aarch64', 'targz', 'corretto-17.0.9')] },
    { vendor: 'Amazon', product: 'Corretto', jdk_version_major: 8, jdk_version: '1.8.0_512', packages: [pkg('macOS', 'aarch64', 'targz', 'corretto-1.8.0_512')] },
    { vendor: 'Azul', product: 'Zulu Community™', jdk_version_major: 17, jdk_version: '17.0.21.0.3', packages: [pkg('macOS', 'aarch64', 'targz', 'azul-17.0.21')] },
    { vendor: 'Eclipse', product: 'Temurin', jdk_version_major: 17, jdk_version: '17.0.21', packages: [pkg('linux', 'x86_64', 'targz', 'temurin-17')] },
    { vendor: 'Oracle', product: 'OpenJDK Early-Access', preview: true, jdk_version_major: 28, jdk_version: '28', packages: [pkg('macOS', 'aarch64', 'targz', 'ea')] },
    { vendor: 'BellSoft', product: 'Liberica JDK', flavour: 'Full', jdk_version_major: 17, jdk_version: '17.0.21', packages: [pkg('macOS', 'aarch64', 'targz', 'full')] },
    { vendor: 'Broken', product: 'Http', jdk_version_major: 17, jdk_version: '17', packages: [{ ...pkg('macOS', 'aarch64', 'targz', 'x'), url: 'http://plain.invalid/x' }] },
    { vendor: 'Broken', product: 'NoHash', jdk_version_major: 17, jdk_version: '17', packages: [{ ...pkg('macOS', 'aarch64', 'targz', 'x'), sha256: 'nope' }] },
    null, { vendor: 'NoPackages' },
  ],
};
const mac = { platform: 'darwin' as const, arch: 'arm64' };

describe('parseJetBrainsFeed', () => {
  it('keeps builds for this OS and CPU and skips previews, flavours and unusable packages', () => {
    const releases = parseJetBrainsFeed(feed, mac);
    expect(releases.map((r) => `${r.vendor} ${r.version}`)).toEqual(
      ['Amazon Corretto 17.0.21', 'Amazon Corretto 17.0.9', 'Amazon Corretto 1.8.0_512', 'Azul Zulu Community 17.0.21.0.3']);
    expect(releases[0]).toMatchObject({ feature: 17, archive: 'targz', folder: 'corretto-17.0.21', sha256: { hex: sha }, size: 10 });
  });

  it('prefers the zip package on Windows', () => {
    const [release] = parseJetBrainsFeed(feed, { platform: 'win32', arch: 'x64' });
    expect(release.archive).toBe('zip');
  });

  it('throws on another shape or when nothing fits the platform', () => {
    expect(() => parseJetBrainsFeed({ nope: [] }, mac)).toThrow(/shape/);
    expect(() => parseJetBrainsFeed(feed, { platform: 'linux', arch: 'arm64' })).toThrow(/no build/);
  });
});

describe('choosing from the catalogue', () => {
  const releases = parseJetBrainsFeed(feed, mac);
  it('lists versions newest first and one build per vendor with Corretto first', () => {
    expect(featuresOf(releases)).toEqual([17, 8]);
    expect(vendorsFor(releases, 17).map((r) => `${r.vendor} ${r.version}`)).toEqual(['Amazon Corretto 17.0.21', 'Azul Zulu Community 17.0.21.0.3']);
    expect(vendorsFor(releases, 11)).toEqual([]);
  });
  it('compares versions number by number', () => {
    expect(compareVersions('17.0.10', '17.0.9')).toBeGreaterThan(0);
    expect(compareVersions('1.8.0_512', '1.8.0_92')).toBeGreaterThan(0);
    expect(compareVersions('3.9', '3.9.0')).toBe(0);
  });
  it('turns a remote folder name into one plain path segment', () => {
    expect(safeFolder('../..\\evil name')).toBe('evil-name');
    expect(safeFolder('Corretto-17.0.21')).toBe('corretto-17.0.21');
    expect(safeFolder('///')).toBe('jdk');
  });
});

describe('loadCatalog', () => {
  const adoptium = [{ binary: { package: { name: 'OpenJDK17U-jdk_aarch64_mac_hotspot_17.0.21_9.tar.gz', link: 'https://example.invalid/t.tar.gz', checksum: sha, size: 5 } }, version: { semver: '17.0.21+9' } }];

  it('uses the feed when it answers', async () => {
    const r = await loadCatalog([jetBrainsCatalog('https://feed.invalid/jdks.json'), fallbackCatalog()], mac, async (url) => {
      expect(url).toBe('https://feed.invalid/jdks.json');
      return feed;
    });
    expect(r.source).toBe('JetBrains JDK feed');
    expect(r.releases).toHaveLength(4);
  });

  it('falls back to Corretto and Adoptium when the feed fails or changes shape', async () => {
    for (const broken of [async () => { throw new Error('HTTP 503'); }, async () => ({ changed: true })]) {
      const r = await loadCatalog([jetBrainsCatalog(), fallbackCatalog([17, 8])], mac, async (url) => {
        if (url.includes('jetbrains')) return broken();
        if (url.includes('/17/')) return adoptium;
        throw new Error('no JDK build for this platform');
      });
      expect(r.source).toBe('Corretto and Adoptium');
      expect(r.releases.map((x) => `${x.vendor} ${x.feature}`).sort()).toEqual(['Amazon Corretto 17', 'Amazon Corretto 8', 'Eclipse Temurin 17']);
      const corretto = r.releases.find((x) => x.vendor === 'Amazon Corretto' && x.feature === 8)!;
      expect(corretto.url).toBe('https://corretto.aws/downloads/latest/amazon-corretto-8-aarch64-macos-jdk.tar.gz');
      expect(corretto.sha256).toEqual({ url: 'https://corretto.aws/downloads/latest_sha256/amazon-corretto-8-aarch64-macos-jdk.tar.gz' });
    }
  });

  it('reports every provider when none answers', async () => {
    await expect(loadCatalog([jetBrainsCatalog()], mac, async () => { throw new Error('offline'); })).rejects.toThrow(/JetBrains JDK feed: offline/);
  });
});
