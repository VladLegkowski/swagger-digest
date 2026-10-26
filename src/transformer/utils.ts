import type { JsonObject } from '../types.js';

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function entries(value: unknown): Array<[string, any]> {
  return isObject(value) ? Object.entries(value) : [];
}

export function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

export function markdownCell(value: unknown): string {
  return cleanText(value).replace(/\|/g, '\\|').replace(/`/g, '\\`') || '—';
}

export function safeSourceUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/(token|secret|password|signature|credential|api[-_]?key|authorization|auth)/i.test(key)) {
        url.searchParams.set(key, '[redacted]');
      }
    }
    return url.toString();
  } catch {
    return value;
  }
}

export function safeComment(value: unknown): string {
  return cleanText(value)
    .replace(/\*\//g, '* /')
    .replace(/[\r\n]+/g, ' ');
}

export function propertyKey(value: string): string {
  return /^[$A-Z_a-z][$\w]*$/.test(value) ? value : JSON.stringify(value);
}

export function toTypeScriptIdentifier(value: string): string {
  let identifier = value.replace(/[^\p{L}\p{N}_$]+/gu, '_').replace(/^([^\p{L}_$])/u, '_$1');
  if (!identifier) identifier = 'Unnamed';
  const reserved = new Set([
    'abstract',
    'any',
    'as',
    'asserts',
    'async',
    'await',
    'boolean',
    'break',
    'case',
    'catch',
    'class',
    'const',
    'constructor',
    'continue',
    'debugger',
    'declare',
    'default',
    'delete',
    'do',
    'else',
    'enum',
    'export',
    'extends',
    'false',
    'finally',
    'for',
    'from',
    'function',
    'get',
    'if',
    'implements',
    'import',
    'in',
    'infer',
    'instanceof',
    'interface',
    'is',
    'keyof',
    'let',
    'module',
    'namespace',
    'never',
    'new',
    'null',
    'number',
    'object',
    'of',
    'package',
    'private',
    'protected',
    'public',
    'readonly',
    'require',
    'return',
    'set',
    'static',
    'string',
    'super',
    'switch',
    'symbol',
    'this',
    'throw',
    'true',
    'try',
    'type',
    'typeof',
    'undefined',
    'unique',
    'unknown',
    'var',
    'void',
    'while',
    'with',
    'yield',
  ]);
  if (reserved.has(identifier)) identifier = `${identifier}Model`;
  return identifier;
}
