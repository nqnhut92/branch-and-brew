import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { removeTempDir } from '../../../test/fixtures/cleanup';
import { detectJdks, inspectJdk, installJdk, parseRelease, pickJdk, type InstalledJdk } from './jdk';
import {
  installMaven, installedMavens, mavenCommand, mavenGoals, mavenUrls, moduleArgs, parseMavenVersions, parseSha512, rememberGoals,
  splitGoals, toolchainEnv,
} from './maven';
import { resolveJava } from './toolchain';

const tmp = mkdtempSync(path.join(tmpdir(), 'bab jdk é-'));
const exe = process.platform === 'win32' ? 'java.exe' : 'java';
// Same tar as extract(): on Windows Git's GNU tar would read "C:" as a remote host.
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

/** A folder that looks like a JDK: bin/java and a release file. */
function fakeJdk(home: string, version: string, vendor = 'Test Vendor'): string {
  mkdirSync(path.join(home, 'bin'), { recursive: true });
  writeFileSync(path.join(home, 'bin', exe), '');
  writeFileSync(path.join(home, 'release'), `IMPLEMENTOR="${vendor}"\nJAVA_VERSION="${version}"\nOS_ARCH="aarch64"\n`);
  return home;
}

const files = new Map<string, Buffer>();
let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const body = files.get(req.url ?? '');
    if (body) res.writeHead(200, { 'Content-Length': body.length }).end(body);
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  removeTempDir(tmp);
});

/** Packs `folder` (inside `parent`) and serves it; returns the archive bytes. */
function serve(url: string, parent: string, folder: string): Buffer {
  const archive = path.join(tmp, `${Math.random().toString(36).slice(2)}.tar.gz`);
  execFileSync(tar, ['-czf', archive, '-C', parent, folder]);
  const bytes = readFileSync(archive);
  files.set(url, bytes);
  return bytes;
}

describe('installed JDKs', () => {
  it('reads version and vendor from the release file', () => {
    expect(parseRelease('IMPLEMENTOR="Amazon.com Inc."\nJAVA_VERSION="1.8.0_392"\n')).toEqual({ version: '1.8.0_392', vendor: 'Amazon.com Inc.' });
    const home = fakeJdk(path.join(tmp, 'inspect', 'jdk'), '17.0.9');
    expect(inspectJdk(home, 'system')).toEqual({ home, feature: 17, version: '17.0.9', vendor: 'Test Vendor', origin: 'system' });
    expect(inspectJdk(path.join(tmp, 'nothing'), 'system')).toBeUndefined();
  });

  it('knows a Java 8 JDK without a release file (Corretto 8) from version.txt or rt.jar', () => {
    const corretto = path.join(tmp, 'c8');
    mkdirSync(path.join(corretto, 'bin'), { recursive: true });
    writeFileSync(path.join(corretto, 'bin', exe), '');
    writeFileSync(path.join(corretto, 'version.txt'), '8.512.09.1\n');
    expect(inspectJdk(corretto, 'system')).toMatchObject({ feature: 8, version: '8.512.09.1' });
    const old = path.join(tmp, 'old8');
    mkdirSync(path.join(old, 'bin'), { recursive: true });
    mkdirSync(path.join(old, 'jre', 'lib'), { recursive: true });
    writeFileSync(path.join(old, 'bin', exe), '');
    writeFileSync(path.join(old, 'jre', 'lib', 'rt.jar'), '');
    expect(inspectJdk(old, 'system')).toMatchObject({ feature: 8, version: '1.8' });
  });

  it('finds downloads, IntelliJ\'s .jdks and JAVA_HOME, each home once', () => {
    const storage = path.join(tmp, 'detect', 'storage');
    const home = path.join(tmp, 'detect', 'home');
    // macOS layout inside our own download; a plain layout in .jdks.
    const ours = fakeJdk(path.join(storage, 'corretto-17', 'amazon-corretto-17.jdk', 'Contents', 'Home'), '17.0.21');
    const idea = fakeJdk(path.join(home, '.jdks', 'corretto-1.8.0_392'), '1.8.0_392');
    mkdirSync(path.join(storage, 'half.extracting'), { recursive: true });
    const found = detectJdks({ storageDir: storage, homeDir: home, env: { JAVA_HOME: idea }, systemFolders: [] });
    expect(found.map((j) => [j.home, j.feature, j.origin])).toEqual([[ours, 17, 'branch-and-brew'], [idea, 8, 'intellij']]);
    expect(detectJdks({ storageDir: path.join(tmp, 'none'), homeDir: path.join(tmp, 'none'), env: {}, systemFolders: [] })).toEqual([]);
  });

  it('picks the matching feature version, our own download and the newest build first', () => {
    const jdk = (home: string, version: string, origin: InstalledJdk['origin']): InstalledJdk => ({ home, version, feature: Number(version.split('.')[0]), origin });
    const installed = [jdk('/sys17', '17.0.30', 'system'), jdk('/idea17', '17.0.2', 'intellij'), jdk('/idea17b', '17.0.10', 'intellij'), jdk('/sys21', '21.0.1', 'system')];
    expect(pickJdk(installed, 17)?.home).toBe('/idea17b');
    expect(pickJdk(installed, 21)?.home).toBe('/sys21');
    expect(pickJdk(installed, 8)).toBeUndefined();
  });
});

describe('installJdk', () => {
  const release = (folder: string, hex: string) => ({
    vendor: 'Amazon Corretto', feature: 17, version: '17.0.21', url: `${base}/jdk.tar.gz`, sha256: { hex }, archive: 'targz' as const, folder,
  });

  it('downloads, verifies, extracts and describes the JDK', async () => {
    const src = path.join(tmp, 'src');
    fakeJdk(path.join(src, 'amazon-corretto-17.jdk', 'Contents', 'Home'), '17.0.21', 'Amazon.com Inc.');
    const bytes = serve('/jdk.tar.gz', src, 'amazon-corretto-17.jdk');
    const hex = createHash('sha256').update(bytes).digest('hex');
    files.set('/sha', Buffer.from(`${hex}\n`));
    const storage = path.join(tmp, 'install');
    const jdk = await installJdk({ ...release('corretto-17.0.21', hex), sha256: { url: `${base}/sha` } }, storage, { allowHttpLocalhost: true });
    expect(jdk).toMatchObject({ feature: 17, version: '17.0.21', vendor: 'Amazon.com Inc.', origin: 'branch-and-brew' });
    expect(jdk.home).toBe(path.join(storage, 'corretto-17.0.21', 'amazon-corretto-17.jdk', 'Contents', 'Home'));
    expect(readdirSync(storage)).toEqual(['corretto-17.0.21']);
    expect(detectJdks({ storageDir: storage, homeDir: path.join(tmp, 'none'), env: {}, systemFolders: [] })).toHaveLength(1);
  });

  it('leaves nothing behind after a wrong checksum or an archive without a JDK', async () => {
    const storage = path.join(tmp, 'install-bad');
    await expect(installJdk(release('bad', '0'.repeat(64)), storage, { allowHttpLocalhost: true })).rejects.toThrow(/checksum/);
    mkdirSync(path.join(tmp, 'empty-src', 'not-a-jdk'), { recursive: true });
    writeFileSync(path.join(tmp, 'empty-src', 'not-a-jdk', 'readme.txt'), 'x');
    const bytes = serve('/jdk.tar.gz', path.join(tmp, 'empty-src'), 'not-a-jdk');
    await expect(installJdk(release('empty', createHash('sha256').update(bytes).digest('hex')), storage, { allowHttpLocalhost: true }))
      .rejects.toThrow(/holds no JDK/);
    expect(readdirSync(storage)).toEqual([]);
  });
});

describe('Maven', () => {
  it('lists stable Maven 3 versions newest first', () => {
    const xml = `<metadata><versioning><latest>4.0.0-rc-7</latest><versions>
      <version>2.2.1</version><version>3.0.3</version><version>3.0.4</version><version>3.9.9</version><version>3.9.16</version>
      <version>3.10.0-rc-1</version><version>3.10.0</version><version>4.0.0-rc-7</version></versions></versioning></metadata>`;
    expect(parseMavenVersions(xml)).toEqual(['3.10.0', '3.9.16', '3.9.9', '3.0.4']);
  });

  it('builds the archive URLs and reads the checksum file', () => {
    expect(mavenUrls('3.9.9', 'darwin')).toEqual({
      archive: 'https://archive.apache.org/dist/maven/maven-3/3.9.9/binaries/apache-maven-3.9.9-bin.tar.gz',
      sha512: 'https://archive.apache.org/dist/maven/maven-3/3.9.9/binaries/apache-maven-3.9.9-bin.tar.gz.sha512',
      extension: '.tar.gz',
    });
    expect(mavenUrls('3.9.9', 'win32').archive).toMatch(/apache-maven-3\.9\.9-bin\.zip$/);
    expect(parseSha512(`${'ab'.repeat(64)}  apache-maven-3.9.9-bin.zip\n`)).toBe('ab'.repeat(64));
    expect(() => parseSha512('<html>')).toThrow();
  });

  it('downloads a Maven version and lists what is installed', async () => {
    const src = path.join(tmp, 'mvn-src', 'apache-maven-3.9.9', 'bin');
    mkdirSync(src, { recursive: true });
    writeFileSync(path.join(src, 'mvn'), '');
    writeFileSync(path.join(src, 'mvn.cmd'), '');
    // The archive name follows the platform (zip on Windows); bsdtar reads either by content.
    const name = `/maven-3/3.9.9/binaries/apache-maven-3.9.9-bin${process.platform === 'win32' ? '.zip' : '.tar.gz'}`;
    const bytes = serve(name, path.join(tmp, 'mvn-src'), 'apache-maven-3.9.9');
    files.set(`${name}.sha512`, Buffer.from(`${createHash('sha512').update(bytes).digest('hex')}  x\n`));
    const storage = path.join(tmp, 'maven');
    const maven = await installMaven('3.9.9', storage, { allowHttpLocalhost: true }, base);
    expect(maven).toEqual({ version: '3.9.9', home: path.join(storage, '3.9.9', 'apache-maven-3.9.9') });
    expect(installedMavens(storage)).toEqual([maven]);
    expect(installedMavens(path.join(tmp, 'none'))).toEqual([]);
  });

  it('builds goals for each action, a module and custom text', () => {
    expect(mavenGoals('build')).toEqual(['clean', 'install']);
    expect(mavenGoals('buildSkipTests')).toEqual(['clean', 'install', '-DskipTests']);
    expect(mavenGoals('test')).toEqual(['test']);
    expect(moduleArgs('services\\api')).toEqual(['-pl', 'services/api', '-am']);
    expect(moduleArgs(undefined)).toEqual([]);
    expect(splitGoals('  clean verify -Dname="two words" -P ci ')).toEqual(['clean', 'verify', '-Dname=two words', '-P', 'ci']);
    expect(rememberGoals(['b', 'a'], ' a ')).toEqual(['a', 'b']);
    expect(rememberGoals(Array.from({ length: 10 }, (_, i) => `g${i}`), 'new')).toHaveLength(10);
  });

  it('starts the wrapper when the repository has one, else the given Maven', () => {
    const repo = path.join(tmp, 'repo');
    mkdirSync(repo, { recursive: true });
    expect(mavenCommand(repo, undefined, 'darwin')).toBeUndefined();
    expect(mavenCommand(repo, '/m', 'darwin')).toEqual({ command: path.join('/m', 'bin', 'mvn'), args: [], kind: 'maven' });
    expect(mavenCommand(repo, 'C:\\m', 'win32')).toEqual({ command: 'cmd.exe', args: ['/d', '/c', path.join('C:\\m', 'bin', 'mvn.cmd')], kind: 'maven' });
    writeFileSync(path.join(repo, 'mvnw'), '');
    writeFileSync(path.join(repo, 'mvnw.cmd'), '');
    expect(mavenCommand(repo, '/m', 'linux')).toEqual({ command: 'sh', args: [path.join(repo, 'mvnw')], kind: 'wrapper' });
    expect(mavenCommand(repo, undefined, 'win32')).toEqual({ command: 'cmd.exe', args: ['/d', '/c', path.join(repo, 'mvnw.cmd')], kind: 'wrapper' });
  });

  it('puts the JDK and Maven in front of PATH, under the name Windows uses', () => {
    expect(toolchainEnv('/jdk', '/mvn', { PATH: '/usr/bin' }, 'darwin')).toEqual({
      JAVA_HOME: '/jdk', MAVEN_HOME: '/mvn', PATH: `${path.join('/jdk', 'bin')}:${path.join('/mvn', 'bin')}:/usr/bin`,
    });
    expect(toolchainEnv('C:\\jdk', undefined, { Path: 'C:\\Windows' }, 'win32')).toEqual({
      JAVA_HOME: 'C:\\jdk', Path: `${path.join('C:\\jdk', 'bin')};C:\\Windows`,
    });
    expect(toolchainEnv(undefined, undefined, { PATH: '/usr/bin' }, 'linux')).toEqual({});
  });
});

describe('resolveJava', () => {
  const jdk = (home: string, feature: number): InstalledJdk => ({ home, feature, version: `${feature}.0.1`, origin: 'branch-and-brew' });
  const installed = [jdk('/j8', 8), jdk('/j17', 17)];
  const pom = (version: string) => () => `<project><properties><maven.compiler.source>${version}</maven.compiler.source></properties></project>`;

  it('selects the JDK the pom asks for', () => {
    expect(resolveJava('/repo', undefined, installed, pom('1.8'))).toMatchObject({ state: 'ok', feature: 8, jdk: { home: '/j8' }, source: 'pom.xml maven.compiler.source' });
    expect(resolveJava('/repo', undefined, installed, pom('17'))).toMatchObject({ state: 'ok', jdk: { home: '/j17' } });
  });

  it('reports a version that is not installed, and a pom that does not say', () => {
    expect(resolveJava('/repo', undefined, installed, pom('21'))).toEqual({ state: 'missing', feature: 21, source: 'pom.xml maven.compiler.source', jdk: undefined });
    expect(resolveJava('/repo', undefined, installed, () => '<project/>')).toEqual({ state: 'unknown' });
    expect(resolveJava('/repo', { feature: 17 }, installed, () => '<project/>')).toMatchObject({ state: 'ok', source: 'chosen for this repository', jdk: { home: '/j17' } });
  });

  it('lets a JDK fixed by hand win, unless it is gone', () => {
    expect(resolveJava('/repo', { home: '/j17' }, installed, pom('1.8'))).toMatchObject({ state: 'ok', source: 'fixed JDK', jdk: { home: '/j17' } });
    expect(resolveJava('/repo', { home: '/gone' }, installed, pom('1.8'))).toMatchObject({ state: 'ok', jdk: { home: '/j8' } });
  });
});

describe('fake JDK helper', () => {
  it('is not mistaken for a JDK without a release file', () => {
    const home = path.join(tmp, 'no-release');
    mkdirSync(path.join(home, 'bin'), { recursive: true });
    writeFileSync(path.join(home, 'bin', exe), '');
    expect(existsSync(path.join(home, 'release'))).toBe(false);
    expect(inspectJdk(home, 'system')).toBeUndefined();
  });
});
