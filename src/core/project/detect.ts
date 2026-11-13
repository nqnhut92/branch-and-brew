import { existsSync } from 'node:fs';
import * as path from 'node:path';

/**
 * What kind of project a folder holds, by the build file at its root. Each kind is one entry
 * here; adding Gradle or npm later is another entry and touches nothing of Maven's.
 */
export interface ProjectKind {
  id: string;
  /** File at the repository root that marks the kind. */
  markers: string[];
}

export const PROJECT_KINDS: ProjectKind[] = [
  { id: 'maven', markers: ['pom.xml'] },
];

export function detectProjectKinds(dir: string, kinds: readonly ProjectKind[] = PROJECT_KINDS): string[] {
  return kinds.filter((k) => k.markers.some((m) => existsSync(path.join(dir, m)))).map((k) => k.id);
}
