import type { JsonObject } from '../types.js';
import { cleanText, entries, isObject } from './utils.js';
import { resolvePointer, resolveReferenceObject } from './schema-type.js';

export interface PayloadExample {
  value: unknown;
  origin: 'declared' | 'schema-derived';
  name?: string;
}

export interface PayloadDescription {
  type?: string;
  mediaType?: string;
  example?: PayloadExample;
  required?: boolean;
}

export function chooseMediaType(content: JsonObject): string | undefined {
  const mediaTypes = Object.keys(content);
  return (
    mediaTypes.find((type) => type.toLowerCase() === 'application/json') ??
    mediaTypes.find((type) => type.toLowerCase().includes('+json')) ??
    mediaTypes[0]
  );
}

export function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function firstDeclaredExample(
  spec: JsonObject,
  schemaValue: unknown,
  seen = new Set<string>(),
): unknown | undefined {
  if (!isObject(schemaValue)) return undefined;
  let schema = schemaValue;
  if (typeof schema.$ref === 'string') {
    if (seen.has(schema.$ref)) return undefined;
    const target = resolvePointer(spec, schema.$ref);
    if (!isObject(target)) return undefined;
    const nextSeen = new Set(seen).add(schema.$ref);
    schema = { ...target, ...Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$ref')) };
    const nested = firstDeclaredExample(spec, schema, nextSeen);
    if (nested !== undefined) return nested;
  }
  if (hasOwn(schema, 'example')) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  return undefined;
}

/**
 * Produce a useful illustrative value when the spec has a schema but no explicit
 * example. This mirrors Swagger UI's schema-driven Example Value closely, while
 * deliberately marking the result as generated rather than spec-authored.
 */
export function generateSchemaExample(
  spec: JsonObject,
  schemaValue: unknown,
  depth = 0,
  seenRefs = new Set<string>(),
): unknown | undefined {
  if (depth > 12 || !isObject(schemaValue)) return undefined;
  let schema = schemaValue;
  let nextSeen = seenRefs;
  if (typeof schema.$ref === 'string') {
    if (seenRefs.has(schema.$ref)) return null;
    const target = resolvePointer(spec, schema.$ref);
    if (!isObject(target)) return undefined;
    nextSeen = new Set(seenRefs).add(schema.$ref);
    schema = { ...target, ...Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$ref')) };
  }

  if (hasOwn(schema, 'example')) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];

  for (const composition of ['oneOf', 'anyOf'] as const) {
    if (Array.isArray(schema[composition]) && schema[composition].length) {
      return generateSchemaExample(spec, schema[composition][0], depth + 1, nextSeen);
    }
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    const values = schema.allOf
      .map((part: unknown) => generateSchemaExample(spec, part, depth + 1, nextSeen))
      .filter((part: unknown) => part !== undefined);
    if (values.every((part: unknown) => isObject(part))) return Object.assign({}, ...values);
    return values[0];
  }

  const rawType = Array.isArray(schema.type) ? schema.type.find((item: unknown) => item !== 'null') : schema.type;
  const type = rawType ?? (schema.properties || schema.additionalProperties !== undefined ? 'object' : undefined);
  if (type === 'array' || schema.items || schema.prefixItems) {
    const tupleSchemas = Array.isArray(schema.prefixItems) ? schema.prefixItems : undefined;
    if (tupleSchemas?.length) {
      return tupleSchemas.slice(0, 3).map((item: unknown) => generateSchemaExample(spec, item, depth + 1, nextSeen));
    }
    const item = generateSchemaExample(spec, schema.items, depth + 1, nextSeen);
    return item === undefined ? [] : [item];
  }
  if (type === 'object') {
    const result: JsonObject = {};
    for (const [name, propertySchema] of entries(schema.properties)) {
      const value = generateSchemaExample(spec, propertySchema, depth + 1, nextSeen);
      if (value !== undefined) result[name] = value;
    }
    if (schema.additionalProperties === true) result.additionalProp1 = 'string';
    else if (isObject(schema.additionalProperties)) {
      const value = generateSchemaExample(spec, schema.additionalProperties, depth + 1, nextSeen);
      if (value !== undefined) result.additionalProp1 = value;
    }
    return result;
  }
  if (type === 'string') {
    switch (cleanText(schema.format).toLowerCase()) {
      case 'uuid':
        return '00000000-0000-4000-8000-000000000001';
      case 'date':
        return '2026-01-01';
      case 'date-time':
        return '2026-01-01T00:00:00Z';
      case 'time':
        return '12:00:00Z';
      case 'email':
        return 'user@example.com';
      case 'uri':
      case 'url':
        return 'https://example.com/resource';
      case 'hostname':
        return 'example.com';
      case 'ipv4':
        return '192.0.2.1';
      case 'ipv6':
        return '2001:db8::1';
      case 'byte':
        return 'c3RyaW5n';
      default:
        return 'string';
    }
  }
  if (type === 'integer' || type === 'number') {
    if (typeof schema.minimum === 'number') return schema.minimum;
    if (typeof schema.exclusiveMinimum === 'number') return schema.exclusiveMinimum + (type === 'integer' ? 1 : 0.1);
    return type === 'integer' ? 0 : 0.0;
  }
  if (type === 'boolean') return true;
  if (type === 'null') return null;
  if (schema.properties || schema.additionalProperties !== undefined) return {};
  return undefined;
}

export function payloadExample(
  spec: JsonObject,
  mediaValue: unknown,
  schemaValue: unknown,
  legacyExamples?: unknown,
): PayloadExample | undefined {
  const media = isObject(mediaValue) ? mediaValue : {};
  if (hasOwn(media, 'example')) return { value: media.example, origin: 'declared' };
  for (const [name, exampleValue] of entries(media.examples)) {
    const example = resolveReferenceObject(spec, exampleValue);
    if (hasOwn(example, 'value')) return { value: example.value, origin: 'declared', name };
  }
  if (isObject(legacyExamples)) {
    const mediaType =
      Object.keys(legacyExamples).find((key) => key.toLowerCase() === 'application/json') ??
      Object.keys(legacyExamples)[0];
    if (mediaType && hasOwn(legacyExamples, mediaType)) {
      return { value: legacyExamples[mediaType], origin: 'declared' };
    }
  }
  const declaredSchemaExample = firstDeclaredExample(spec, schemaValue);
  if (declaredSchemaExample !== undefined) return { value: declaredSchemaExample, origin: 'declared' };
  const generated = generateSchemaExample(spec, schemaValue);
  return generated === undefined ? undefined : { value: generated, origin: 'schema-derived' };
}

export function formattedExample(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    return 'null';
  }
}
