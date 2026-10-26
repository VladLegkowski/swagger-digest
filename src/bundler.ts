import { parse as parseYaml } from 'yaml';
import type { JsonObject } from './types.js';
import { isObject } from './transformer/utils.js';

const MAX_EXTERNAL_DOCUMENTS = 5;

/**
 * External $ref bundling (best effort, one level deep).
 *
 * Finds JSON Schema `$ref` values that point at other HTTP(S) documents,
 * fetches them through the provided `fetchDocument` hook, and inlines the
 * referenced schemas into the main spec's schema bucket
 * (`#/components/schemas/` or `#/definitions/`) under namespaced,
 * collision-free names. Original `$ref` strings are rewritten to the local
 * pointers, so the rest of the transformer only ever sees internal refs.
 *
 * Deliberate limitations:
 * - One level deep: external refs inside a fetched document stay external and
 *   degrade later (named identifier), exactly like unresolvable refs today.
 * - At most 5 documents are fetched; any failure is swallowed so the digest
 *   degrades gracefully instead of erroring out.
 */
export async function bundleExternalRefs(
  spec: JsonObject,
  sourceUrl: string | undefined,
  fetchDocument: (url: string) => Promise<string>,
): Promise<JsonObject> {
  if (!sourceUrl) return spec;

  const externalRefs = collectExternalRefs(spec);
  if (externalRefs.size === 0) return spec;

  const schemaBucket = openSchemaBucket(spec);
  const usedNames = new Set(Object.keys(schemaBucket));
  const mapping = new Map<string, string>();
  let fetched = 0;

  for (const ref of externalRefs) {
    if (fetched >= MAX_EXTERNAL_DOCUMENTS) break;
    const { docUrl, pointer } = splitExternalRef(ref, sourceUrl);
    if (!docUrl) continue;

    try {
      const text = await fetchDocument(docUrl);
      const parsed: unknown = parseDocumentText(text);
      if (parsed === undefined) continue;
      fetched += 1;
      const target = resolvePointer(parsed, pointer);
      if (target === undefined) continue;

      const localName = uniqueNameFor(localNameFor(docUrl, pointer), usedNames);
      schemaBucket[localName] = target as JsonObject;
      mapping.set(ref, localName);
    } catch {
      // Unreachable or unparsable external document: leave the ref untouched;
      // the transformer degrades it to a named identifier as before.
    }
  }

  if (mapping.size === 0) return spec;
  const rewritten = rewriteRefs(spec, mapping);
  return isObject(rewritten) ? (rewritten as JsonObject) : spec;
}

/** Every `$ref` in the document that does not start with `#` (i.e. external). */
function collectExternalRefs(node: unknown): Set<string> {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!isObject(value)) return;
    for (const [key, refValue] of Object.entries(value)) {
      if (key === '$ref' && typeof refValue === 'string' && !refValue.startsWith('#')) {
        found.add(refValue);
        continue;
      }
      if (key === 'example' || key === 'examples' || key === 'externalDocs') continue;
      walk(refValue);
    }
  };
  walk(node);
  return found;
}

/**
 * Rewrites every external `$ref` to its bundled local pointer, cloning only
 * the nodes on the path to a rewritten ref (structural sharing elsewhere).
 */
function rewriteRefs(node: unknown, mapping: Map<string, string>): unknown {
  if (Array.isArray(node)) return node.map((item) => rewriteRefs(item, mapping));
  if (!isObject(node)) return node;
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string') {
      const localName = mapping.get(value);
      if (localName === undefined) {
        result[key] = value;
        continue;
      }
      result[key] = `#/${bucketPath(bucketStyle(value))}/${localName}`;
      continue;
    }
    result[key] = rewriteRefs(value, mapping) as JsonObject;
  }
  return result;
}

function bucketStyle(ref: string): 'openapi' | 'swagger' {
  return ref.includes('/components/') ? 'openapi' : 'swagger';
}

function bucketPath(style: 'openapi' | 'swagger'): string {
  return style === 'openapi' ? 'components/schemas' : 'definitions';
}

function openSchemaBucket(spec: JsonObject): JsonObject {
  if (isObject(spec.components)) {
    if (!isObject(spec.components.schemas)) spec.components.schemas = {};
    return spec.components.schemas;
  }
  if (!isObject(spec.definitions)) spec.definitions = {};
  return spec.definitions;
}

/** Splits `https://host/doc.yaml#/components/schemas/Name` into URL and pointer. */
function splitExternalRef(ref: string, baseUrl: string): { docUrl: string | undefined; pointer: string } {
  const hashIndex = ref.indexOf('#');
  if (hashIndex < 0) return { docUrl: undefined, pointer: '' };
  const docPart = ref.slice(0, hashIndex);
  const pointer = ref.slice(hashIndex + 1);
  try {
    // Relative refs (./meta.json#/, meta.json#/) resolve against the spec URL.
    return { docUrl: new URL(docPart, baseUrl).toString(), pointer };
  } catch {
    return { docUrl: undefined, pointer };
  }
}

function parseDocumentText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return parseYaml(text);
    } catch {
      return undefined;
    }
  }
}

/** JSON-pointer lookup with ~0/~1 unescaping against a fetched document. */
function resolvePointer(root: unknown, pointer: string): unknown {
  if (!pointer.startsWith('/')) return undefined;
  let current: unknown = root;
  for (const rawPart of pointer.slice(1).split('/')) {
    const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObject(current)) return undefined;
    current = current[part];
  }
  return current;
}

/** Readable, collision-resistant local name: `<file-stem>_<pointer-name>`. */
function localNameFor(docUrl: string, pointer: string): string {
  try {
    const url = new URL(docUrl);
    const file = url.pathname.split('/').pop() ?? 'external';
    const stem = file.replace(/\.(json|ya?ml)$/i, '').replace(/[^A-Za-z0-9_$]+/g, '_') || 'external';
    const segments = pointer.split('/').filter(Boolean);
    const pointerName = segments.length > 0 ? segments[segments.length - 1] : undefined;
    const cleanedPointer = pointerName?.replace(/[^A-Za-z0-9_$]+/g, '_');
    return [stem, cleanedPointer].filter(Boolean).join('_') || 'external';
  } catch {
    return 'external';
  }
}

function uniqueNameFor(base: string, used: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${candidate}${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}
