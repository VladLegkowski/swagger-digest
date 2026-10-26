import type { JsonObject } from './types.js';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
const COMMON_ERROR_CODES = new Set([
  '400',
  '401',
  '403',
  '404',
  '405',
  '409',
  '415',
  '422',
  '429',
  '500',
  '501',
  '502',
  '503',
  'default',
]);

type HttpMethod = (typeof HTTP_METHODS)[number];
interface Endpoint {
  method: HttpMethod;
  path: string;
  operation: JsonObject;
  pathParameters: JsonObject[];
  tag: string;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function entries(value: unknown): Array<[string, any]> {
  return isObject(value) ? Object.entries(value) : [];
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function markdownCell(value: unknown): string {
  return cleanText(value).replace(/\|/g, '\\|').replace(/`/g, '\\`') || '—';
}

function safeSourceUrl(value: string): string {
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

function safeComment(value: unknown): string {
  return cleanText(value)
    .replace(/\*\//g, '* /')
    .replace(/[\r\n]+/g, ' ');
}

function schemaMetadata(schemaValue: unknown): string[] {
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
    if (schema[property] !== undefined)
      metadata.push(
        `${label}: ${typeof schema[property] === 'string' ? schema[property] : JSON.stringify(schema[property])}`,
      );
  }
  if (schema.readOnly === true) metadata.push('read-only');
  if (schema.writeOnly === true) metadata.push('write-only');
  if (schema.deprecated === true) metadata.push('deprecated');
  return [...new Set(metadata)];
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

function propertyKey(value: string): string {
  return /^[$A-Z_a-z][$\w]*$/.test(value) ? value : JSON.stringify(value);
}

function refName(ref: string): string | undefined {
  const parts = ref.split('/');
  const last = parts[parts.length - 1];
  if (!last) return undefined;
  const decoded = last.replace(/~1/g, '/').replace(/~0/g, '~');
  return toTypeScriptIdentifier(decoded);
}

function isSchemaRef(ref: string): boolean {
  return ref.includes('/components/schemas/') || ref.includes('/definitions/');
}

function nullableType(type: string, schema: JsonObject): string {
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

function typeExpression(schemaValue: unknown, depth = 0): string {
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
      base = cleanText(schema.format) ? `string /* format: ${safeComment(schema.format)} */` : 'string';
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

function getSchemaDictionary(spec: JsonObject): Record<string, JsonObject> {
  const schemas = spec.components?.schemas ?? spec.definitions ?? {};
  return isObject(schemas) ? schemas : {};
}

function collectSchemaRefs(
  value: unknown,
  output: Set<string>,
  root?: JsonObject,
  seen = new Set<object>(),
  followedRefs = new Set<string>(),
): void {
  if (!value || typeof value !== 'object' || seen.has(value as object)) return;
  seen.add(value as object);
  if (Array.isArray(value)) {
    for (const item of value) collectSchemaRefs(item, output, root, seen, followedRefs);
    return;
  }
  const object = value as JsonObject;
  if (typeof object.$ref === 'string') {
    if (isSchemaRef(object.$ref)) {
      const name = refName(object.$ref);
      if (name) output.add(name);
    } else if (root && object.$ref.startsWith('#/') && !followedRefs.has(object.$ref)) {
      followedRefs.add(object.$ref);
      const target = resolvePointer(root, object.$ref);
      if (target !== undefined) collectSchemaRefs(target, output, root, seen, followedRefs);
    }
  }
  for (const [key, child] of Object.entries(object)) {
    if (key !== 'example' && key !== 'examples' && key !== 'externalDocs')
      collectSchemaRefs(child, output, root, seen, followedRefs);
  }
}

function referencedSchemas(spec: JsonObject): Array<[string, JsonObject]> {
  const dictionary = getSchemaDictionary(spec);
  const knownByName = new Map<string, [string, JsonObject]>();
  for (const [name, schema] of Object.entries(dictionary)) {
    knownByName.set(toTypeScriptIdentifier(name), [name, schema]);
  }

  const refs = new Set<string>();
  collectSchemaRefs(spec.paths ?? {}, refs, spec);
  const selected = new Set<string>();
  const queue = [...refs];
  while (queue.length) {
    const name = queue.shift();
    if (!name || selected.has(name)) continue;
    selected.add(name);
    const model = knownByName.get(name);
    if (!model) continue;
    const childRefs = new Set<string>();
    collectSchemaRefs(model[1], childRefs, spec);
    for (const child of childRefs) if (!selected.has(child)) queue.push(child);
  }

  return [...selected]
    .map((name) => knownByName.get(name))
    .filter((entry): entry is [string, JsonObject] => Boolean(entry));
}

function modelDeclaration(name: string, schema: JsonObject): string {
  const identifier = toTypeScriptIdentifier(name);
  const description = safeComment(schema.description);
  const comment = description ? `/** ${description} */\n` : '';

  if (schema.$ref) return `${comment}type ${identifier} = ${typeExpression(schema)};`;
  if (Array.isArray(schema.enum) || schema.const !== undefined || schema.oneOf || schema.anyOf || schema.allOf) {
    return `${comment}type ${identifier} = ${typeExpression(schema)};`;
  }
  const kind = Array.isArray(schema.type) ? schema.type.find((item: unknown) => item !== 'null') : schema.type;
  if (kind === 'object' || schema.properties || schema.additionalProperties !== undefined) {
    const properties = entries(schema.properties);
    const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
    const fields = properties.map(([field, value]) => {
      const metadata = schemaMetadata(value).map(safeComment).filter(Boolean).join('; ');
      const doc = metadata ? `    /** ${metadata} */\n` : '';
      return `${doc}    ${propertyKey(field)}${required.has(field) ? '' : '?'}: ${typeExpression(value)};`;
    });
    if (schema.additionalProperties === true) fields.push('    [key: string]: unknown;');
    else if (isObject(schema.additionalProperties))
      fields.push(`    [key: string]: ${typeExpression(schema.additionalProperties)};`);
    return `${comment}interface ${identifier} {\n${fields.join('\n')}\n}`;
  }
  return `${comment}type ${identifier} = ${typeExpression(schema)};`;
}

function resolvePointer(root: JsonObject, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let current: unknown = root;
  for (const rawPart of ref.slice(2).split('/')) {
    const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObject(current)) return undefined;
    current = current[part];
  }
  return current;
}

function resolveReferenceObject(spec: JsonObject, value: unknown, seen = new Set<string>()): JsonObject {
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

function getEndpoints(spec: JsonObject): Endpoint[] {
  const result: Endpoint[] = [];
  const paths = isObject(spec.paths) ? spec.paths : {};
  for (const [path, pathItemValue] of Object.entries(paths)) {
    if (!isObject(pathItemValue)) continue;
    const pathParameters = Array.isArray(pathItemValue.parameters)
      ? pathItemValue.parameters.map((parameter: unknown) => resolveReferenceObject(spec, parameter))
      : [];
    for (const method of HTTP_METHODS) {
      const operationValue = pathItemValue[method];
      if (!isObject(operationValue)) continue;
      const firstTag =
        Array.isArray(operationValue.tags) && operationValue.tags.length ? String(operationValue.tags[0]) : 'General';
      result.push({ method, path, operation: operationValue, pathParameters, tag: firstTag });
    }
  }
  return result;
}

function getServers(spec: JsonObject): string[] {
  if (Array.isArray(spec.servers) && spec.servers.length) {
    return spec.servers.map((server: any) => cleanText(server?.url)).filter(Boolean);
  }
  if (isObject(spec)) {
    const host = cleanText(spec.host);
    if (host) {
      const schemes = Array.isArray(spec.schemes) && spec.schemes.length ? spec.schemes : ['https'];
      const basePath = cleanText(spec.basePath) || '/';
      return schemes.map(
        (scheme: string) => `${scheme}://${host}${basePath.startsWith('/') ? basePath : `/${basePath}`}`,
      );
    }
  }
  return [];
}

function describeSecurityScheme(name: string, scheme: JsonObject): string {
  const type = cleanText(scheme.type).toLowerCase();
  const label = cleanText(scheme.description);
  let details = name;
  if (type === 'http' && cleanText(scheme.scheme).toLowerCase() === 'bearer')
    details += ' (Bearer token via Authorization header)';
  else if (type === 'http' && cleanText(scheme.scheme).toLowerCase() === 'basic')
    details += ' (HTTP Basic via Authorization header)';
  else if (type === 'apikey' || type === 'apiKey')
    details += ` (API key in ${cleanText(scheme.in) || 'header'}: ${cleanText(scheme.name) || 'key'})`;
  else if (type === 'oauth2') {
    const flows =
      entries(scheme.flows)
        .map(([flowName]) => flowName)
        .join(', ') || cleanText(scheme.flow);
    details += ` (OAuth2${flows ? `; ${flows}` : ''})`;
  } else if (type === 'openidconnect' || type === 'openIdConnect') details += ' (OpenID Connect)';
  else if (type === 'basic') details += ' (HTTP Basic)';
  else if (type) details += ` (${type})`;
  if (label) details += ` — ${label}`;
  return details;
}

function getSecuritySchemes(spec: JsonObject): Array<[string, JsonObject]> {
  const dictionary = spec.components?.securitySchemes ?? spec.securityDefinitions ?? {};
  return entries(dictionary).filter((entry): entry is [string, JsonObject] => isObject(entry[1]));
}

function securityRequirement(spec: JsonObject, operation: JsonObject): string {
  const security = operation.security !== undefined ? operation.security : spec.security;
  if (!Array.isArray(security) || security.length === 0) return 'None explicitly required';
  const allSchemes = new Map(getSecuritySchemes(spec));
  return security
    .map((requirement: unknown) => {
      if (!isObject(requirement)) return '';
      const names = Object.entries(requirement).map(([name, scopes]) => {
        const label = allSchemes.has(name) ? name : `${name} (scheme not defined)`;
        return Array.isArray(scopes) && scopes.length ? `${label} [scopes: ${scopes.join(', ')}]` : label;
      });
      return names.length ? names.join(' + ') : 'No auth';
    })
    .filter(Boolean)
    .join(' OR ');
}

function parameterType(parameter: JsonObject): string {
  if (isObject(parameter.schema)) return typeExpression(parameter.schema);
  if (parameter.type === 'array') return `${typeExpression(parameter.items)}[]`;
  if (parameter.type) return typeExpression({ type: parameter.type, format: parameter.format, enum: parameter.enum });
  return 'unknown';
}

function mergedParameters(spec: JsonObject, endpoint: Endpoint): JsonObject[] {
  const operationParameters = Array.isArray(endpoint.operation.parameters)
    ? endpoint.operation.parameters.map((parameter: unknown) => resolveReferenceObject(spec, parameter))
    : [];
  const byIdentity = new Map<string, JsonObject>();
  for (const parameter of [...endpoint.pathParameters, ...operationParameters]) {
    if (parameter.in === 'body') continue;
    const key = `${cleanText(parameter.in)}:${cleanText(parameter.name)}`;
    if (key !== ':') byIdentity.set(key, parameter);
  }
  return [...byIdentity.values()];
}

function parameterTable(parameters: JsonObject[]): string {
  if (!parameters.length) return '_None._';
  const rows = parameters.map((parameter) => {
    const required = parameter.required === true || parameter.in === 'path';
    const descriptionParts = [cleanText(parameter.description)];
    if (Array.isArray(parameter.enum) && parameter.enum.length)
      descriptionParts.push(`enum: ${parameter.enum.map(String).join(', ')}`);
    if (parameter.default !== undefined) descriptionParts.push(`default: ${String(parameter.default)}`);
    return `| ${markdownCell(parameter.in)} | \`${markdownCell(parameter.name)}\` | \`${markdownCell(parameterType(parameter))}\` | ${required ? 'Yes' : 'No'} | ${markdownCell(descriptionParts.filter(Boolean).join('; '))} |`;
  });
  return ['| In | Name | Type | Required | Notes |', '|---|---|---|---|---|', ...rows].join('\n');
}

function chooseMediaType(content: JsonObject): string | undefined {
  const mediaTypes = Object.keys(content);
  return (
    mediaTypes.find((type) => type.toLowerCase() === 'application/json') ??
    mediaTypes.find((type) => type.toLowerCase().includes('+json')) ??
    mediaTypes[0]
  );
}

interface PayloadExample {
  value: unknown;
  origin: 'declared' | 'schema-derived';
  name?: string;
}

interface PayloadDescription {
  type?: string;
  mediaType?: string;
  example?: PayloadExample;
  required?: boolean;
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function firstDeclaredExample(spec: JsonObject, schemaValue: unknown, seen = new Set<string>()): unknown | undefined {
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
function generateSchemaExample(
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

function payloadExample(
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

function requestPayloadDescription(spec: JsonObject, operation: JsonObject): PayloadDescription | undefined {
  if (isObject(operation.requestBody) || operation.requestBody?.$ref) {
    const body = resolveReferenceObject(spec, operation.requestBody);
    const content = isObject(body.content) ? body.content : {};
    const mediaType = chooseMediaType(content);
    const media = mediaType ? content[mediaType] : undefined;
    const schema = isObject(media?.schema) ? media.schema : undefined;
    return {
      type: schema ? typeExpression(schema) : 'unknown',
      mediaType: mediaType || 'unknown media type',
      example: media || schema ? payloadExample(spec, media, schema) : undefined,
      required: body.required === true,
    };
  }

  const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
  const bodyParameter = parameters.find((parameter: unknown) => isObject(parameter) && parameter.in === 'body') as
    JsonObject | undefined;
  if (bodyParameter) {
    const consumes = Array.isArray(operation.consumes)
      ? operation.consumes
      : Array.isArray(spec.consumes)
        ? spec.consumes
        : ['application/json'];
    return {
      type: typeExpression(bodyParameter.schema),
      mediaType: consumes[0] ?? 'application/json',
      example: payloadExample(spec, undefined, bodyParameter.schema),
      required: bodyParameter.required === true,
    };
  }
  return undefined;
}

function responseSchema(spec: JsonObject, responseValue: unknown): PayloadDescription {
  const response = resolveReferenceObject(spec, responseValue);
  if (isObject(response.content)) {
    const mediaType = chooseMediaType(response.content);
    const media = mediaType ? response.content[mediaType] : undefined;
    const schema = isObject(media?.schema) ? media.schema : undefined;
    return {
      type: schema ? typeExpression(schema) : undefined,
      mediaType,
      example: schema || media ? payloadExample(spec, media, schema, response.examples) : undefined,
    };
  }
  if (isObject(response.schema)) {
    return {
      type: typeExpression(response.schema),
      mediaType: 'application/json',
      example: payloadExample(spec, undefined, response.schema, response.examples),
    };
  }
  return {};
}

function formattedExample(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    return 'null';
  }
}

function responseBlock(spec: JsonObject, code: string, responseValue: unknown): string {
  const response = resolveReferenceObject(spec, responseValue);
  const description = cleanText(response.description);
  const payload = responseSchema(spec, responseValue);
  const suffix = payload.type
    ? ` — \`${payload.type}\`${payload.mediaType ? ` (${payload.mediaType})` : ''}`
    : ' — no body schema declared';
  const lines = [`- **${markdownCell(code)}${description ? ` ${description}` : ''}**${suffix}`];
  if (payload.example) {
    const origin =
      payload.example.origin === 'declared' ? 'declared in the spec' : 'generated from schema; illustrative only';
    const label = payload.example.name ? ` · ${payload.example.name}` : '';
    lines.push(
      '',
      `  **Example Value** *(${origin}${label})*`,
      '',
      '  ```json',
      ...formattedExample(payload.example.value)
        .split('\n')
        .map((line) => `  ${line}`),
      '  ```',
    );
  }
  return lines.join('\n');
}

function responseSection(spec: JsonObject, operation: JsonObject): string {
  const responses = entries(operation.responses).filter(([, value]) => isObject(value));
  if (!responses.length) return '_No responses declared._';

  const success = responses.filter(([code]) => /^2\d\d$/.test(code));
  success.sort(([a], [b]) => (a === '200' ? -1 : b === '200' ? 1 : Number(a) - Number(b)));
  const errors = responses.filter(([code]) => COMMON_ERROR_CODES.has(code) || /^([45])\d\d$/.test(code));
  const selected = [
    ...success.slice(0, 1),
    ...errors.filter(([code]) => !success.some(([successCode]) => successCode === code)),
  ];
  const lines = selected.map(([code, response]) => responseBlock(spec, code, response));

  if (success.length > 1) {
    const others = success.slice(1).map(([code, response]) => responseBlock(spec, code, response));
    lines.push('', '<details><summary>Other successful responses</summary>', '', ...others, '', '</details>');
  }
  if (!selected.length) {
    return responses.map(([code, response]) => responseBlock(spec, code, response)).join('\n\n');
  }
  return lines.join('\n');
}

function shortOperationDescription(operation: JsonObject): string {
  return markdownCell(operation.summary || operation.operationId || operation.description || '—');
}

function endpointMarkdown(spec: JsonObject, endpoint: Endpoint): string {
  const { operation, method, path } = endpoint;
  const heading = `#### \`${method.toUpperCase()} ${path}\``;
  const summary = cleanText(operation.summary);
  const description = cleanText(operation.description);
  const lines = [heading];
  if (summary) lines.push('', summary);
  if (description && description !== summary) lines.push('', description);
  lines.push('', `**Authentication:** ${securityRequirement(spec, operation)}`);

  const parameters = mergedParameters(spec, endpoint);
  const request = requestPayloadDescription(spec, operation);
  lines.push('', '**Parameters**');
  lines.push(parameterTable(parameters));
  if (request) {
    lines.push(
      '',
      `**Request body:** \`${request.mediaType}\` → \`${request.type}\`${request.required ? ' (required)' : ' (optional)'}`,
    );
    if (request.example) {
      const origin =
        request.example.origin === 'declared' ? 'declared in the spec' : 'generated from schema; illustrative only';
      const label = request.example.name ? ` · ${request.example.name}` : '';
      lines.push(
        '',
        `**Request Example Value** *(${origin}${label})*`,
        '',
        '```json',
        formattedExample(request.example.value),
        '```',
      );
    }
  }
  lines.push('', '**Responses**', responseSection(spec, operation));
  return lines.join('\n');
}

function authOverview(spec: JsonObject): string[] {
  const schemes = getSecuritySchemes(spec);
  if (!schemes.length) return ['- **Authentication:** No security schemes declared.'];
  const globalSecurity = securityRequirement(spec, {});
  return [
    `- **Authentication required globally:** ${globalSecurity}`,
    '- **Available schemes:**',
    ...schemes.map(([name, scheme]) => `  - ${describeSecurityScheme(name, scheme)}`),
  ];
}

function collectTags(spec: JsonObject, endpoints: Endpoint[]): string[] {
  const declared = Array.isArray(spec.tags) ? spec.tags.map((tag: any) => cleanText(tag?.name)).filter(Boolean) : [];
  const encountered = [...new Set(endpoints.map((endpoint) => endpoint.tag))];
  return [
    ...declared.filter((tag: string) => encountered.includes(tag)),
    ...encountered.filter((tag) => !declared.includes(tag)),
  ];
}

function endpointTypeBase(method: string, path: string, operation: JsonObject): string {
  if (cleanText(operation.operationId)) return toTypeScriptIdentifier(cleanText(operation.operationId));
  const pathName = path
    .replace(/[{}]/g, '')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return toTypeScriptIdentifier(`${method.charAt(0).toUpperCase()}${method.slice(1)}${pathName}`);
}

function normalizeInlinePayloadSchemas(spec: JsonObject): JsonObject {
  const document = structuredClone(spec) as JsonObject;
  const isOpenApi3 = typeof document.openapi === 'string';
  const schemaPointer = isOpenApi3 ? '#/components/schemas/' : '#/definitions/';
  let schemaBucket: JsonObject;
  if (isOpenApi3) {
    if (!isObject(document.components)) document.components = {};
    if (!isObject(document.components.schemas)) document.components.schemas = {};
    schemaBucket = document.components.schemas;
  } else {
    if (!isObject(document.definitions)) document.definitions = {};
    schemaBucket = document.definitions;
  }

  const uniqueName = (suggestion: string): string => {
    const base = toTypeScriptIdentifier(suggestion);
    let candidate = base;
    let suffix = 2;
    while (Object.prototype.hasOwnProperty.call(schemaBucket, candidate)) {
      candidate = `${base}${suffix}`;
      suffix += 1;
    }
    return candidate;
  };

  const replaceInline = (schema: unknown, name: string): unknown => {
    if (!isObject(schema) || typeof schema.$ref === 'string' || Object.keys(schema).length === 0) return schema;
    const unique = uniqueName(name);
    schemaBucket[unique] = schema;
    return { $ref: `${schemaPointer}${unique.replace(/~/g, '~0').replace(/\//g, '~1')}` };
  };

  // Normalize reusable request/response components too, while reachable-schema filtering
  // below ensures unused components do not inflate the final digest.
  const reusableBodies = isOpenApi3 ? document.components?.requestBodies : document.parameters;
  for (const [bodyName, bodyValue] of entries(reusableBodies)) {
    if (!isObject(bodyValue)) continue;
    if (isOpenApi3 && isObject(bodyValue.content)) {
      const mediaType = chooseMediaType(bodyValue.content);
      const media = mediaType ? bodyValue.content[mediaType] : undefined;
      if (isObject(media) && isObject(media.schema)) media.schema = replaceInline(media.schema, `${bodyName}Request`);
    } else if (!isOpenApi3 && bodyValue.in === 'body' && isObject(bodyValue.schema)) {
      bodyValue.schema = replaceInline(bodyValue.schema, `${bodyName}Request`);
    }
  }

  const reusableResponses = isOpenApi3 ? document.components?.responses : document.responses;
  for (const [responseName, responseValue] of entries(reusableResponses)) {
    if (!isObject(responseValue)) continue;
    if (isOpenApi3 && isObject(responseValue.content)) {
      const mediaType = chooseMediaType(responseValue.content);
      const media = mediaType ? responseValue.content[mediaType] : undefined;
      if (isObject(media) && isObject(media.schema))
        media.schema = replaceInline(media.schema, `${responseName}Response`);
    } else if (!isOpenApi3 && isObject(responseValue.schema)) {
      responseValue.schema = replaceInline(responseValue.schema, `${responseName}Response`);
    }
  }

  const paths = isObject(document.paths) ? document.paths : {};
  for (const [path, pathItemValue] of Object.entries(paths)) {
    if (!isObject(pathItemValue)) continue;
    for (const method of HTTP_METHODS) {
      const operation = pathItemValue[method];
      if (!isObject(operation)) continue;
      const base = endpointTypeBase(method, path, operation);

      if (isOpenApi3 && isObject(operation.requestBody) && isObject(operation.requestBody.content)) {
        const content = operation.requestBody.content;
        const mediaType = chooseMediaType(content);
        const media = mediaType ? content[mediaType] : undefined;
        if (isObject(media) && isObject(media.schema)) {
          media.schema = replaceInline(media.schema, `${base}Request`);
        }
      } else if (!isOpenApi3 && Array.isArray(operation.parameters)) {
        for (const parameter of operation.parameters) {
          if (isObject(parameter) && parameter.in === 'body' && isObject(parameter.schema)) {
            parameter.schema = replaceInline(parameter.schema, `${base}Request`);
          }
        }
      }

      if (isObject(operation.responses)) {
        for (const [code, responseValue] of Object.entries(operation.responses)) {
          if (!isObject(responseValue) || typeof responseValue.$ref === 'string') continue;
          const suffix = code === 'default' ? 'Default' : code.replace(/[^a-zA-Z0-9]/g, '');
          if (isObject(responseValue.content)) {
            const mediaType = chooseMediaType(responseValue.content);
            const media = mediaType ? responseValue.content[mediaType] : undefined;
            if (isObject(media) && isObject(media.schema)) {
              media.schema = replaceInline(media.schema, `${base}${suffix}Response`);
            }
          } else if (!isOpenApi3 && isObject(responseValue.schema)) {
            responseValue.schema = replaceInline(responseValue.schema, `${base}${suffix}Response`);
          }
        }
      }
    }
  }

  return document;
}

/** Convert an OpenAPI 2.0, 3.0, or 3.1 document to a compact Markdown digest. */
export function transformOpenApiToMarkdown(spec: JsonObject, sourceUrl?: string): string {
  const normalizedSpec = normalizeInlinePayloadSchemas(spec);
  spec = normalizedSpec;
  const info = isObject(spec.info) ? spec.info : {};
  const title = cleanText(info.title) || 'API';
  const version = cleanText(info.version) || 'unspecified';
  const openApiVersion = cleanText(spec.openapi) || (spec.swagger ? `Swagger ${spec.swagger}` : 'OpenAPI');
  const servers = getServers(spec);
  const endpoints = getEndpoints(spec);
  const tags = collectTags(spec, endpoints);
  const indexRows = endpoints.map(
    (endpoint) =>
      `| **${endpoint.method.toUpperCase()}** | \`${markdownCell(endpoint.path)}\` | ${shortOperationDescription(endpoint.operation)} | ${markdownCell(Array.isArray(endpoint.operation.tags) ? endpoint.operation.tags.join(', ') : endpoint.tag)} |`,
  );
  const groupedEndpoints = tags
    .map((tag) => {
      const members = endpoints.filter((endpoint) => endpoint.tag === tag);
      if (!members.length) return '';
      return [`### ${tag}`, ...members.map((endpoint) => endpointMarkdown(spec, endpoint))].join('\n\n');
    })
    .filter(Boolean);
  const models = referencedSchemas(spec);
  const modelSection = models.length
    ? [
        '## Data types',
        '',
        ...models.map(([name, schema]) => `### ${name}\n\n\`\`\`typescript\n${modelDeclaration(name, schema)}\n\`\`\``),
      ].join('\n\n')
    : '';
  const description = cleanText(info.description);

  const sections = [
    `# API Digest: ${title}`,
    '',
    `> Spec: ${openApiVersion} · API version: ${version}${sourceUrl ? ` · Source: \`${markdownCell(safeSourceUrl(sourceUrl))}\`` : ''}`,
    '',
    '## Overview',
    ...(description ? ['', description] : []),
    '',
    `- **Base URL(s):** ${servers.length ? servers.map((server) => `\`${markdownCell(server)}\``).join(', ') : 'Not declared'}`,
    ...authOverview(spec),
    '',
    '## Quick index',
    '',
    '| Method | Path | Summary | Tags |',
    '|---|---|---|---|',
    ...(indexRows.length ? indexRows : ['| — | — | No operations declared | — |']),
    '',
    '## Endpoints',
    '',
    ...(groupedEndpoints.length ? groupedEndpoints : ['_No endpoints declared._']),
    ...(modelSection ? ['', modelSection] : []),
  ];

  return `${sections
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;
}
