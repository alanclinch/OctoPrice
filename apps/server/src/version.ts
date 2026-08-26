/**
 * Build identity.
 *
 * DESIGN.md section 34 asks for version and commit to come from Git rather
 * than being copied into several files by hand. The commit is read from the
 * environment first (which is how a container or CI build should supply it),
 * falling back to asking Git directly during local development.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export interface BuildInfo {
  version: string;
  commit: string;
}

let cached: BuildInfo | null = null;

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // Works from both src/ and dist/.
    for (const candidate of [
      join(here, '..', 'package.json'),
      join(here, '..', '..', 'package.json'),
    ]) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: string };
        if (parsed.version) return parsed.version;
      } catch {
        // Try the next candidate.
      }
    }
  } catch {
    // Fall through to the default.
  }
  return '0.0.0';
}

function readCommit(): string {
  const fromEnv = process.env.OCTOPRICE_COMMIT ?? process.env.GIT_COMMIT;
  if (fromEnv) return fromEnv.slice(0, 12);

  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

export function buildInfo(): BuildInfo {
  cached ??= { version: readPackageVersion(), commit: readCommit() };
  return cached;
}
