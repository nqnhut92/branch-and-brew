import { existsSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { at, child, children, parseXml, type XmlNode } from './xml';

export interface PomJavaVersion {
  /** Feature version: 8, 11, 17… */
  feature: number;
  /** Where it was found, for the toolchain summary. */
  source: string;
}

/** "1.8" and "8" are Java 8; "17" and "17.0.2" are Java 17. */
export function parseJavaVersion(value: string | undefined): number | undefined {
  const m = value?.trim().match(/^(\d+)(?:\.(\d+))?/);
  if (!m) return undefined;
  const feature = m[1] === '1' && m[2] ? Number(m[2]) : Number(m[1]);
  return feature >= 5 && feature < 100 ? feature : undefined;
}

interface Pom {
  file: string;
  project: XmlNode | undefined;
  parent?: Pom;
}

/** Loads a pom and its chain of local parents (`relativePath`, default `../pom.xml`). */
function loadPom(file: string, read: (file: string) => string | undefined, depth = 0): Pom | undefined {
  const text = read(file);
  if (text === undefined) return undefined;
  const project = child(parseXml(text), 'project');
  const pom: Pom = { file, project };
  const parent = child(project, 'parent');
  if (parent && depth < 10) {
    const relative = child(parent, 'relativePath');
    // An empty <relativePath/> means: do not look on disk.
    if (!relative || relative.text) {
      let target = path.resolve(path.dirname(file), relative?.text || '../pom.xml');
      if (!target.toLowerCase().endsWith('.xml')) target = path.join(target, 'pom.xml');
      if (path.resolve(target) !== path.resolve(file)) pom.parent = loadPom(target, read, depth + 1);
    }
  }
  return pom;
}

/** A property as the child sees it: its own value wins over the parents'. */
function property(pom: Pom | undefined, name: string): string | undefined {
  for (let p = pom; p; p = p.parent) {
    const value = at(p.project, 'properties', name)?.text;
    if (value) return value;
  }
  return undefined;
}

function resolve(pom: Pom, value: string | undefined, depth = 0): string | undefined {
  if (!value || depth > 5) return value;
  return value.replace(/\$\{([^}]+)\}/g, (whole, name: string) => resolve(pom, property(pom, name), depth + 1) ?? whole);
}

function compilerPlugins(p: Pom): XmlNode[] {
  const build = child(p.project, 'build');
  const plugins = [...children(child(build, 'plugins'), 'plugin'), ...children(at(build, 'pluginManagement', 'plugins'), 'plugin')];
  return plugins.filter((plugin) => child(plugin, 'artifactId')?.text === 'maven-compiler-plugin');
}

/**
 * The Java version a pom asks for, in the plan's order: maven.compiler.release, then
 * maven.compiler.source and target, then java.version, then the compiler plugin's configuration.
 * Each is looked up in the pom and its local parents.
 */
export function readJavaVersion(pomFile: string, read: (file: string) => string | undefined = readFileOrUndefined): PomJavaVersion | undefined {
  const pom = loadPom(pomFile, read);
  if (!pom) return undefined;
  for (const name of ['maven.compiler.release', 'maven.compiler.source', 'maven.compiler.target', 'java.version']) {
    const feature = parseJavaVersion(resolve(pom, property(pom, name)));
    if (feature) return { feature, source: name };
  }
  for (let p: Pom | undefined = pom; p; p = p.parent) {
    for (const plugin of compilerPlugins(p)) {
      for (const name of ['release', 'source', 'target']) {
        const feature = parseJavaVersion(resolve(pom, at(plugin, 'configuration', name)?.text));
        if (feature) return { feature, source: `maven-compiler-plugin <${name}>` };
      }
    }
  }
  return undefined;
}

/** Module folders listed in a pom's <modules>, as written. */
export function readModules(pomFile: string, read: (file: string) => string | undefined = readFileOrUndefined): string[] {
  const text = read(pomFile);
  if (text === undefined) return [];
  return children(at(parseXml(text), 'project', 'modules'), 'module').map((m) => m.text).filter(Boolean);
}

function readFileOrUndefined(file: string): string | undefined {
  try {
    return existsSync(file) && statSync(file).isFile() ? readFileSync(file, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}
