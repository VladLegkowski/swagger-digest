import { createRequire } from 'node:module';

/**
 * Reads the package version relative to a module URL. Returns "unknown" when
 * package.json cannot be read — never a hardcoded version number, so a broken
 * build layout is visible instead of silently wrong.
 */
export function readPackageVersion(moduleUrl: string): string {
  // Bundled entries can land at different depths (dist/cli.js vs dist/mcp/index.js),
  // so walk up until package.json is found.
  const require = createRequire(moduleUrl);
  for (const candidate of ['../package.json', '../../package.json']) {
    try {
      const pkg = require(candidate) as { version?: unknown };
      if (typeof pkg?.version === 'string' && pkg.version) return pkg.version;
    } catch {
      // Try the next parent directory.
    }
  }
  return 'unknown';
}

export const VERSION: string = readPackageVersion(import.meta.url);

export const USER_AGENT: string = `swagger-digest/${VERSION}`;
