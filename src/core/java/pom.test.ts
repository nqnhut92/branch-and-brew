import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseJavaVersion, readJavaVersion, readModules } from './pom';
import { at, parseXml } from './xml';

const project = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <!-- <properties><java.version>99</java.version></properties> -->
  ${body}
</project>`;

const root = path.resolve('/work/app');
const files = (map: Record<string, string>) => {
  const resolved = Object.fromEntries(Object.entries(map).map(([k, v]) => [path.resolve(root, k), v]));
  return (file: string) => resolved[path.resolve(file)];
};
const version = (map: Record<string, string>, pom = 'pom.xml') => readJavaVersion(path.join(root, pom), files(map));

describe('parseXml', () => {
  it('reads nested elements, self-closing tags, CDATA and entities', () => {
    const doc = parseXml('<a x="1"><b>one &amp; two</b><c/><d><![CDATA[<raw>]]></d><ns:e>3</ns:e></a>');
    expect(at(doc, 'a', 'b')?.text).toBe('one & two');
    expect(at(doc, 'a', 'c')?.text).toBe('');
    expect(at(doc, 'a', 'd')?.text).toBe('<raw>');
    expect(at(doc, 'a', 'e')?.text).toBe('3');
  });
});

describe('parseJavaVersion', () => {
  it('normalises 1.x and plain versions', () => {
    expect(parseJavaVersion('1.8')).toBe(8);
    expect(parseJavaVersion('8')).toBe(8);
    expect(parseJavaVersion(' 17 ')).toBe(17);
    expect(parseJavaVersion('17.0.2')).toBe(17);
    expect(parseJavaVersion('${java.version}')).toBeUndefined();
    expect(parseJavaVersion(undefined)).toBeUndefined();
  });
});

describe('readJavaVersion', () => {
  it('prefers maven.compiler.release, then source, then java.version', () => {
    expect(version({ 'pom.xml': project('<properties><java.version>11</java.version><maven.compiler.source>1.8</maven.compiler.source><maven.compiler.release>17</maven.compiler.release></properties>') }))
      .toEqual({ feature: 17, source: 'maven.compiler.release' });
    expect(version({ 'pom.xml': project('<properties><java.version>11</java.version><maven.compiler.source>1.8</maven.compiler.source></properties>') }))
      .toEqual({ feature: 8, source: 'maven.compiler.source' });
    expect(version({ 'pom.xml': project('<properties><java.version>11</java.version></properties>') }))
      .toEqual({ feature: 11, source: 'java.version' });
  });

  it('resolves property references', () => {
    expect(version({ 'pom.xml': project('<properties><jdk>1.8</jdk><maven.compiler.source>${jdk}</maven.compiler.source></properties>') })?.feature).toBe(8);
  });

  it('reads the compiler plugin configuration, also under pluginManagement', () => {
    const plugin = '<plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId><configuration><source>1.8</source><target>1.8</target></configuration></plugin>';
    expect(version({ 'pom.xml': project(`<build><plugins><plugin><artifactId>other</artifactId></plugin>${plugin}</plugins></build>`) }))
      .toEqual({ feature: 8, source: 'maven-compiler-plugin <source>' });
    expect(version({ 'pom.xml': project(`<build><pluginManagement><plugins>${plugin}</plugins></pluginManagement></build>`) })?.feature).toBe(8);
  });

  it('follows a local parent pom, by default path and by relativePath', () => {
    const parent = project('<properties><java.version>17</java.version></properties><modules><module>service</module><module>lib/core</module></modules>');
    const map = {
      'pom.xml': parent,
      'service/pom.xml': project('<parent><artifactId>app</artifactId></parent>'),
      'lib/core/pom.xml': project('<parent><artifactId>app</artifactId><relativePath>../../pom.xml</relativePath></parent>'),
      'alone/pom.xml': project('<parent><artifactId>spring-boot-starter-parent</artifactId><relativePath/></parent>'),
      'override/pom.xml': project('<parent><artifactId>app</artifactId></parent><properties><java.version>21</java.version></properties>'),
    };
    expect(version(map, 'service/pom.xml')).toEqual({ feature: 17, source: 'java.version' });
    expect(version(map, 'lib/core/pom.xml')?.feature).toBe(17);
    expect(version(map, 'alone/pom.xml')).toBeUndefined();
    expect(version(map, 'override/pom.xml')?.feature).toBe(21);
    expect(readModules(path.join(root, 'pom.xml'), files(map))).toEqual(['service', 'lib/core']);
  });

  it('finds nothing in a pom that does not say, or in a missing file', () => {
    expect(version({ 'pom.xml': project('<artifactId>x</artifactId>') })).toBeUndefined();
    expect(version({})).toBeUndefined();
    expect(readModules(path.join(root, 'pom.xml'), files({}))).toEqual([]);
  });
});
