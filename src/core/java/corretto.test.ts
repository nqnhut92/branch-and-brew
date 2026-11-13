import { describe, expect, it } from 'vitest';
import { correttoArch, correttoFileName, correttoOs, correttoUrls, parseSha256 } from './corretto';

describe('corretto', () => {
  it('maps platforms and builds the documented file names', () => {
    expect(correttoOs('win32')).toBe('windows');
    expect(correttoOs('darwin')).toBe('macos');
    expect(correttoArch('arm64')).toBe('aarch64');
    expect(correttoFileName(17, 'windows', 'x64')).toBe('amazon-corretto-17-x64-windows-jdk.zip');
    expect(correttoFileName(8, 'macos', 'aarch64')).toBe('amazon-corretto-8-aarch64-macos-jdk.tar.gz');
  });

  it('builds the latest and latest_sha256 URLs', () => {
    expect(correttoUrls(8, 'linux', 'x64')).toEqual({
      archive: 'https://corretto.aws/downloads/latest/amazon-corretto-8-x64-linux-jdk.tar.gz',
      sha256: 'https://corretto.aws/downloads/latest_sha256/amazon-corretto-8-x64-linux-jdk.tar.gz',
    });
  });

  it('parses the checksum text and rejects anything else', () => {
    const hex = '30c7edb7134712148cc323d4ccfc816758e7f1e4bb8aa1287795872fa5eca610';
    expect(parseSha256(`${hex.toUpperCase()}\n`)).toBe(hex);
    expect(() => parseSha256('<html>not found</html>')).toThrow();
  });
});
