import type { JsonObject } from '../types.js';
import { cleanText, entries, isObject, propertyKey, safeComment, toTypeScriptIdentifier } from './utils.js';

export function schemaMetadata(schemaValue: unknown): string[] {
  if (!isObject(schemaValue)) return [];
  const schema = schemaValue;
  const metadata: string[] = [];
  if (cleanText(schema.description)) metadata.push(cleanText(schema.description));
  if (cleanText(schema.format)) metadata.push(`format: ${cleanText(schema.format)}`);
  const constraints: Array<[string, string]> = [
    ['default', 'default'],
    ['pattern', 'pattern'],
    ['minLength', 'minLength'],
    ['maxLength', 'maxLength'],
    ['minimum', 'minimum'],
    ['maximum', 'maximum'],
    ['exclusiveMinimum', 'exclusiveMinimum'],
    ['exclusiveMaximum', 'exclusiveMaximum'],
    ['minItems', 'minItems'],
    ['maxItems', 'maxItems'],
    ['uniqueItems', 'uniqueItems'],
    ['multipleOf', 'multipleOf'],
  ];
  for (const [property, label] of constraints) {
    const value = schema[property];
    if (value === undefined) continue;
    if (property === 'default' && (value === null || value === '')) continue;
    metadata.push(
      `${label}: ${property === 'default' ? JSON.stringify(value) : typeof value === 'string' ? value : JSON.stringify(value)}`,
    );
  }
  if (schema.readOnly === true) metadata.push('read-only');
  if (schema.writeOnly === true) metadata.push('write-only');
  if (schema.deprecated === true) metadata.push('deprecated');
  return [...new Set(metadata)];
}

export function refName(ref: string): string | undefined {
  const parts = ref.split('/');
  const last = parts[parts.length - 1];
  if (!last) return undefined;
  const decoded = last.replace(/~1/g, '/').replace(/~0/g, '~');
  return toTypeScriptIdentifier(decoded);
}

export function isSchemaRef(ref: string): boolean {
  return ref.includes('/components/schemas/') || ref.includes('/definitions/');
}

export function nullableType(type: string, schema: JsonObject): string {
  const typeList = Array.isArray(schema.type) ? schema.type : [];
  if (schema.nullable === true || typeList.includes('null')) {
    if (!type.split(/\s*\|\s*/).includes('null')) return `${parenthesizeUnion(type)} | null`;
  }
  return type;
}

function parenthesizeUnion(type: string): string {
  return type.includes(' | ') ? `(${type})` : type;
}

function literalType(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return 'unknown';
}

export function typeExpression(schemaValue: unknown, depth = 0): string {
  if (depth > 12 || !isObject(schemaValue)) return 'unknown';
  const schema = schemaValue;

  if (typeof schema.$ref === 'string') {
    return refName(schema.$ref) ?? 'unknown';
  }
  if (schema.const !== undefined) return nullableType(literalType(schema.const), schema);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return nullableType([...new Set(schema.enum.map(literalType))].join(' | '), schema);
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return nullableType(schema.oneOf.map((item: unknown) => typeExpression(item, depth + 1)).join(' | '), schema);
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return nullableType(schema.anyOf.map((item: unknown) => typeExpression(item, depth + 1)).join(' | '), schema);
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const components = schema.allOf.map((item: unknown) => typeExpression(item, depth + 1));
    if (schema.properties || schema.additionalProperties !== undefined) {
      components.push(
        typeExpression(
          {
            type: 'object',
            properties: schema.properties,
            required: schema.required,
            additionalProperties: schema.additionalProperties,
          },
          depth + 1,
        ),
      );
    }
    return nullableType(components.join(' & '), schema);
  }

  const rawType = Array.isArray(schema.type) ? schema.type.filter((item: unknown) => item !== 'null') : schema.type;
  const type = Array.isArray(rawType) ? rawType[0] : rawType;

  if (type === 'array' || schema.items) {
    const itemType = typeExpression(schema.items, depth + 1);
    return nullableType(`${itemType.includes(' | ') ? `(${itemType})` : itemType}[]`, schema);
  }
  if (type === 'object' || schema.properties || schema.additionalProperties !== undefined) {
    const properties = entries(schema.properties);
    const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
    const lines = properties.map(([name, propertySchema]) => {
      const metadata = schemaMetadata(propertySchema).map(safeComment).filter(Boolean).join('; ');
      const comment = metadata ? `/** ${metadata} */ ` : '';
      return `${comment}${propertyKey(name)}${required.has(name) ? '' : '?'}: ${typeExpression(propertySchema, depth + 1)};`;
    });
    if (schema.additionalProperties === true) lines.push('[key: string]: unknown;');
    else if (isObject(schema.additionalProperties))
      lines.push(`[key: string]: ${typeExpression(schema.additionalProperties, depth + 1)};`);
    return nullableType(lines.length ? `{ ${lines.join(' ')} }` : 'Record<string, unknown>', schema);
  }

  let base: string;
  switch (type) {
    case 'string':
    case 'file':
      base = cleanText(schema.format) ? `string /* ${safeComment(schema.format)} */` : 'string';
      break;
    case 'integer':
    case 'number':
      base = 'number';
      break;
    case 'boolean':
      base = 'boolean';
      break;
    case 'null':
      base = 'null';
      break;
    default:
      base = 'unknown';
  }
  return nullableType(base, schema);
}

export function getSchemaDictionary(spec: JsonObject): Record<string, JsonObject> {
  const schemas = spec.components?.schemas ?? spec.definitions ?? {};
  return isObject(schemas) ? schemas : {};
}

export function resolvePointer(root: JsonObject, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let current: unknown = root;
  for (const rawPart of ref.slice(2).split('/')) {
    const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObject(current)) return undefined;
    current = current[part];
  }
  return current;
}

export function resolveReferenceObject(spec: JsonObject, value: unknown, seen = new Set<string>()): JsonObject {
  if (!isObject(value)) return {};
  if (typeof value.$ref !== 'string') return value;
  const ref = value.$ref;
  if (seen.has(ref)) return {};
  const target = resolvePointer(spec, ref);
  if (!isObject(target)) return value;
  const nextSeen = new Set(seen).add(ref);
  return {
    ...resolveReferenceObject(spec, target, nextSeen),
    ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$ref')),
  };
}
