import { describe, expect, it } from 'vitest';
import { adoptiumArch, adoptiumOs, latestAssetUrl, parseLatestAssets } from './adoptium';

describe('adoptium', () => {
  it('maps Node platform and CPU names', () => {
    expect(adoptiumOs('win32')).toBe('windows');
    expect(adoptiumOs('darwin')).toBe('mac');
    expect(adoptiumArch('arm64')).toBe('aarch64');
    expect(adoptiumArch('x64')).toBe('x64');
    expect(() => adoptiumArch('ia32')).toThrow();
  });

  it('builds the latest-assets URL', () => {
    expect(latestAssetUrl(17, 'windows', 'x64')).toBe(
      'https://api.adoptium.net/v3/assets/latest/17/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse',
    );
  });

  it('parses the response captured from the live API', () => {
    // Trimmed from GET /v3/assets/latest/17/hotspot?architecture=aarch64&image_type=jdk&os=mac&vendor=eclipse
    const sample = [{
      binary: { architecture: 'aarch64', os: 'mac', image_type: 'jdk', package: {
        checksum: '78b08c7f5a0598242d5719c022e19479cb4a3aa45c37c19726a757a469ed1c15',
        link: 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.21%2B9/OpenJDK17U-jdk_aarch64_mac_hotspot_17.0.21_9.tar.gz',
        name: 'OpenJDK17U-jdk_aarch64_mac_hotspot_17.0.21_9.tar.gz',
        size: 186192554,
      } },
      version: { semver: '17.0.21+9' },
    }];
    expect(parseLatestAssets(sample)).toEqual({
      name: 'OpenJDK17U-jdk_aarch64_mac_hotspot_17.0.21_9.tar.gz',
      link: sample[0].binary.package.link,
      sha256: sample[0].binary.package.checksum,
      size: 186192554,
      version: '17.0.21+9',
    });
  });

  it('rejects an empty or reshaped response', () => {
    expect(() => parseLatestAssets([])).toThrow(/no JDK build/);
    expect(() => parseLatestAssets([{ binary: {} }])).toThrow(/shape/);
  });
});
