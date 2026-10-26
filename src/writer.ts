import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function defaultOutputDirectory(): string {
  return path.join(os.homedir(), 'Downloads');
}

export function defaultFilename(apiTitle?: string): string {
  const slug = (apiTitle ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'api'}-digest.md`;
}

export function resolveOutputDirectory(directory: string, cwd = process.cwd()): string {
  const expanded =
    directory === '~'
      ? os.homedir()
      : directory.startsWith(`~${path.sep}`)
        ? path.join(os.homedir(), directory.slice(2))
        : directory;
  return path.resolve(cwd, expanded);
}

export function normalizeFilename(filename: string, fallback = 'api-digest.md'): string {
  const normalized = filename.trim().replace(/\\/g, '/');
  const basename = path.posix.basename(normalized);
  if (!basename || basename === '.' || basename === '..') return fallback;
  return basename.toLowerCase().endsWith('.md') ? basename : `${basename}.md`;
}

export async function writeDigest(options: { markdown: string; directory: string; filename: string }): Promise<string> {
  const directory = resolveOutputDirectory(options.directory);
  const filename = normalizeFilename(options.filename);
  const outputPath = path.join(directory, filename);
  await mkdir(directory, { recursive: true });
  await writeFile(outputPath, options.markdown, { encoding: 'utf8' });
  return outputPath;
}
