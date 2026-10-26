import type { JsonObject } from '../types.js';
import { entries, isObject, safeComment, toTypeScriptIdentifier, propertyKey } from './utils.js';
import {
  getSchemaDictionary,
  refName,
  isSchemaRef,
  resolvePointer,
  typeExpression,
  schemaMetadata,
} from './schema-type.js';
import { chooseMediaType } from './examples.js';
import { HTTP_METHODS, endpointTypeBase } from './endpoints.js';

export function collectSchemaRefs(
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

export function referencedSchemas(spec: JsonObject): Array<[string, JsonObject]> {
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

export function modelDeclaration(name: string, schema: JsonObject): string {
  const identifier = toTypeScriptIdentifier(name);
  const description = safeComment(schema.description);
  const comment = description ? `/** ${description} */\n` : '';

  if (schema.$ref) return `${comment}export type ${identifier} = ${typeExpression(schema)};`;
  if (Array.isArray(schema.enum) || schema.const !== undefined || schema.oneOf || schema.anyOf || schema.allOf) {
    return `${comment}export type ${identifier} = ${typeExpression(schema)};`;
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
    return `${comment}export interface ${identifier} {\n${fields.join('\n')}\n}`;
  }
  return `${comment}export type ${identifier} = ${typeExpression(schema)};`;
}

export function normalizeInlinePayloadSchemas(spec: JsonObject): JsonObject {
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
