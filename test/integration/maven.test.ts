import * as assert from 'node:assert';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/host/extension';
import { removeTempDir } from '../fixtures/cleanup';

async function api(): Promise<TestApi> {
  return vscode.extensions.getExtension<TestApi>('nqnhut92.branch-and-brew')!.activate();
}

const windows = process.platform === 'win32';
const pom = (properties: string, extra = '') => `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>test</groupId><artifactId>app</artifactId><version>1</version>
  <properties><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>${properties}</properties>
  ${extra}
</project>
`;

/** A folder with a pom.xml (the Maven actions need no git repository). */
function project(root: string, name: string, properties: string, extra = ''): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'pom.xml'), pom(properties, extra));
  return dir;
}

suite('Java and Maven toolchain (stub JDKs and Maven)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bab maven é-'));
  const jdkDir = path.join(root, 'jdk');
  const mavenDir = path.join(root, 'maven');
  // The Windows stub is a batch file, which writes in the console's code page rather than UTF-8:
  // letters outside ASCII (the é of the temp folder) are compared as placeholders.
  const ascii = (text: string) => text.replace(/[^\x20-\x7e]+/g, '?');
  const ran = (repo: string) => readFileSync(path.join(repo, 'maven-ran.txt'), 'latin1').split(/\r?\n/).map((l) => ascii(l.trim()));

  /** A folder that looks like a JDK to the detector. */
  const fakeJdk = (folder: string, version: string) => {
    const home = path.join(jdkDir, folder);
    mkdirSync(path.join(home, 'bin'), { recursive: true });
    writeFileSync(path.join(home, 'bin', windows ? 'java.exe' : 'java'), '');
    writeFileSync(path.join(home, 'release'), `IMPLEMENTOR="Stub"\nJAVA_VERSION="${version}"\n`);
    return home;
  };

  suiteSetup(async () => {
    // A Maven that records JAVA_HOME and its arguments, and fails when the first goal is "fail".
    const bin = path.join(mavenDir, '3.9.9', 'apache-maven-3.9.9', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, 'mvn'), '#!/bin/sh\nprintf \'%s\\n\' "$JAVA_HOME" > maven-ran.txt\nprintf \'%s\\n\' "$*" >> maven-ran.txt\n[ "$1" = fail ] && exit 3\nexit 0\n');
    chmodSync(path.join(bin, 'mvn'), 0o755);
    writeFileSync(path.join(bin, 'mvn.cmd'), '@echo off\r\necho %JAVA_HOME%> maven-ran.txt\r\necho %*>> maven-ran.txt\r\nif "%1"=="fail" exit /b 3\r\nexit /b 0\r\n');
    const { java } = await api();
    java.overrides = { jdkDir, mavenDir, detect: { homeDir: path.join(root, 'home'), env: {}, systemFolders: [] } };
    java.refresh();
  });

  suiteTeardown(async () => {
    const { java } = await api();
    java.overrides = {};
    java.refresh();
    removeTempDir(root);
  });

  test('a Java 8 and a Java 17 project each run Maven with their own JDK', async function () {
    this.timeout(60_000);
    const { java, mavenStatus, runMaven, describeToolchain } = await api();
    const jdk8 = fakeJdk('corretto-1.8.0_392', '1.8.0_392');
    const jdk17 = fakeJdk('corretto-17.0.9', '17.0.9');
    java.refresh();
    const legacy = project(root, 'legacy app', '<maven.compiler.source>1.8</maven.compiler.source><maven.compiler.target>1.8</maven.compiler.target>');
    const modern = project(root, 'modern app', '<java.version>17</java.version>');

    assert.strictEqual(java.resolve(legacy).jdk?.home, jdk8);
    assert.strictEqual(java.resolve(modern).jdk?.home, jdk17);
    assert.deepStrictEqual(describeToolchain(modern).slice(0, 1), ['Java needed: 17 (pom.xml java.version)']);
    assert.match(describeToolchain(modern)[2], /^Maven: 3\.9\.9 at /);

    assert.strictEqual(await runMaven(legacy, ['clean', 'install']), 0);
    assert.deepStrictEqual(ran(legacy).slice(0, 2), [ascii(jdk8), 'clean install']);
    assert.strictEqual(mavenStatus.get(legacy), 'passed');

    assert.strictEqual(await runMaven(modern, ['clean', 'install', '-DskipTests']), 0);
    assert.deepStrictEqual(ran(modern).slice(0, 2), [ascii(jdk17), 'clean install -DskipTests']);

    // A failing run comes back with Maven's exit code and marks the row.
    assert.strictEqual(await runMaven(modern, ['fail']), 3);
    assert.strictEqual(mavenStatus.get(modern), 'failed');
    assert.strictEqual(mavenStatus.get(legacy), 'passed');

    // A JDK fixed by hand wins over the pom; back to automatic restores it.
    await java.setChoice(legacy, { home: jdk17 });
    assert.strictEqual(await runMaven(legacy, ['test']), 0);
    assert.strictEqual(ran(legacy)[0], ascii(jdk17));
    await java.setChoice(legacy, undefined);
    assert.strictEqual(java.resolve(legacy).jdk?.home, jdk8);

    // The terminal for a repository gets the same JAVA_HOME, with the JDK first on PATH.
    const env = java.env(modern);
    assert.strictEqual(env.JAVA_HOME, jdk17);
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path')!;
    assert.ok(env[pathKey].startsWith(path.join(jdk17, 'bin')));
  });

  test('the wrapper is used when the project has one', async function () {
    this.timeout(60_000);
    const { java, runMaven, describeToolchain } = await api();
    fakeJdk('corretto-21.0.1', '21.0.1');
    java.refresh();
    const wrapped = project(root, 'wrapped', '<maven.compiler.release>21</maven.compiler.release>');
    // No executable bit on purpose: a repository checked out on Windows has none.
    writeFileSync(path.join(wrapped, 'mvnw'), '#!/bin/sh\nprintf \'wrapper %s\\n\' "$*" > maven-ran.txt\n');
    writeFileSync(path.join(wrapped, 'mvnw.cmd'), '@echo off\r\necho wrapper %*> maven-ran.txt\r\n');
    assert.strictEqual(describeToolchain(wrapped)[2], 'Maven: the repository\'s wrapper (mvnw)');
    assert.strictEqual(await runMaven(wrapped, ['verify']), 0);
    assert.strictEqual(ran(wrapped)[0], 'wrapper verify');
  });

  test('a version that is not installed is reported, not downloaded', async () => {
    const { java, describeToolchain } = await api();
    const future = project(root, 'future', '<maven.compiler.release>25</maven.compiler.release>');
    assert.deepStrictEqual([java.resolve(future).state, java.resolve(future).feature], ['missing', 25]);
    assert.strictEqual(describeToolchain(future)[1], 'JDK: no Java 25 installed');
    const silent = project(root, 'silent', '');
    assert.strictEqual(java.resolve(silent).state, 'unknown');
    await java.setChoice(silent, { feature: 17 });
    assert.strictEqual(java.resolve(silent).jdk?.feature, 17);
    await java.setChoice(silent, undefined);
    assert.ok(!existsSync(path.join(jdkDir, 'corretto-25')));
  });
});

// The toolchain end to end with real downloads: downloads two JDKs and Maven (about 400 MB) and lets Maven
// fetch its plugins from Maven Central, so it only runs on request.
const real = process.env.BAB_REAL_DOWNLOAD === '1';

suite('Java 8 and Java 17 projects build with downloaded JDKs', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bab real maven é-'));
  suiteTeardown(async () => {
    const { java } = await api();
    java.overrides = {};
    java.refresh();
    removeTempDir(root);
  });

  (real ? test : test.skip)('on a machine with no Java, each project builds with its own JDK', async function () {
    this.timeout(1_800_000);
    const { java, runMaven } = await api();
    // Nothing installed: empty storage, no IntelliJ JDKs, no JAVA_HOME, no system JDKs.
    java.overrides = { jdkDir: path.join(root, 'jdk'), mavenDir: path.join(root, 'maven'), detect: { homeDir: path.join(root, 'home'), env: {}, systemFolders: [] } };
    java.refresh();
    assert.deepStrictEqual(java.installedJdks(), []);

    const source = (dir: string, body: string) => {
      mkdirSync(path.join(dir, 'src', 'main', 'java', 'app'), { recursive: true });
      writeFileSync(path.join(dir, 'src', 'main', 'java', 'app', 'Main.java'), `package app;\npublic class Main { public static void main(String[] a) { ${body} } }\n`);
    };
    const legacy = project(root, 'java 8 app', '<maven.compiler.source>1.8</maven.compiler.source><maven.compiler.target>1.8</maven.compiler.target>');
    source(legacy, 'System.out.println("8");');
    // A text block needs Java 15+, so this one cannot be built by the Java 8 JDK.
    const modern = project(root, 'java 17 app', '<maven.compiler.release>17</maven.compiler.release>');
    source(modern, 'System.out.println("""\n17""");');
    assert.strictEqual(java.resolve(legacy).state, 'missing');

    const { source: catalogSource, releases } = await java.catalog();
    console.log(`      catalogue: ${catalogSource}, ${releases.length} builds`);
    for (const feature of [8, 17]) {
      const release = releases.filter((r) => r.feature === feature && r.vendor === 'Amazon Corretto')
        .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
      assert.ok(release, `Corretto ${feature} is in the catalogue`);
      const jdk = await java.installRelease(release);
      console.log(`      installed ${jdk.vendor} ${jdk.version} at ${jdk.home}`);
      assert.strictEqual(jdk.feature, feature);
    }
    const [newest] = await java.mavenVersions();
    const maven = await java.installMavenVersion(newest);
    console.log(`      installed Maven ${maven.version}`);

    /** Major version of a class file: 52 is Java 8, 61 is Java 17. */
    const classVersion = (dir: string) => readFileSync(path.join(dir, 'target', 'classes', 'app', 'Main.class')).readUInt16BE(6);
    assert.strictEqual(await runMaven(legacy, ['clean', 'install']), 0);
    assert.strictEqual(classVersion(legacy), 52);
    assert.strictEqual(await runMaven(modern, ['clean', 'install']), 0);
    assert.strictEqual(classVersion(modern), 61);
    assert.strictEqual(java.resolve(legacy).jdk!.feature, 8);
    assert.match(java.resolve(modern).jdk!.version, /^17\./);
  });
});
