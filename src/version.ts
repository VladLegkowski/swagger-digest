import { createRequire } from 'node:module';

/**
 * Reads the package version relative to a module URL. Returns "unknown" when
 * package.json cannot be read — never a hardcoded version number, so a broken
 * build layout is visible instead of silently wrong.
 */
export function readPackageVersion(moduleUrl: string): string {
  try {
    const require = createRequire(moduleUrl);
    const pkg = require('../package.json') as { version?: unknown };
    if (typeof pkg?.version === 'string' && pkg.version) return pkg.version;
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export const VERSION: string = readPackageVersion(import.meta.url);

export const USER_AGENT: string = `swagger-digest/${VERSION}`;
