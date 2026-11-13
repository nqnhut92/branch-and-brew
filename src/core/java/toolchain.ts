import * as path from 'node:path';
import { pickJdk, type InstalledJdk } from './jdk';
import { readJavaVersion } from './pom';

/** What the user chose for one repository. */
export interface JavaChoice {
  /** A JDK home picked by hand; overrides everything. */
  home?: string;
  /** The Java version answered when the pom does not say. */
  feature?: number;
}

export interface JavaResolution {
  /** Java version the repository needs, when known. */
  feature?: number;
  /** Where the version came from: a pom property, "chosen for this repository", or "fixed JDK". */
  source?: string;
  /** The JDK that will be used. */
  jdk?: InstalledJdk;
  /**
   * `ok`: a JDK is selected. `missing`: the version is known but no such JDK is installed.
   * `unknown`: the pom does not say which Java it needs and nobody has answered yet.
   */
  state: 'ok' | 'missing' | 'unknown';
}

const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** Picks the JDK for a repository from its pom.xml, the user's choice and the JDKs on the machine. */
export function resolveJava(
  repo: string, choice: JavaChoice | undefined, installed: readonly InstalledJdk[],
  read?: (file: string) => string | undefined,
): JavaResolution {
  const fixed = choice?.home && installed.find((j) => same(j.home, choice.home!));
  if (fixed) return { feature: fixed.feature, source: 'fixed JDK', jdk: fixed, state: 'ok' };
  const fromPom = readJavaVersion(path.join(repo, 'pom.xml'), read);
  const feature = fromPom?.feature ?? choice?.feature;
  if (!feature) return { state: 'unknown' };
  const source = fromPom ? `pom.xml ${fromPom.source}` : 'chosen for this repository';
  const jdk = pickJdk(installed, feature);
  return { feature, source, jdk, state: jdk ? 'ok' : 'missing' };
}
