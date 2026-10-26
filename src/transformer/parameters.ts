import type { JsonObject } from '../types.js';
import { cleanText, isObject } from './utils.js';
import { typeExpression, resolveReferenceObject } from './schema-type.js';
import { shortenDescription, type RenderStyle, FULL_STYLE } from './render-style.js';
import { chooseMediaType, payloadExample, type PayloadDescription } from './examples.js';
import type { Endpoint } from './endpoints.js';

export function mergedParameters(spec: JsonObject, endpoint: Endpoint): JsonObject[] {
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

export function parameterType(parameter: JsonObject): string {
  if (isObject(parameter.schema)) return typeExpression(parameter.schema);
  if (parameter.type === 'array') return `${typeExpression(parameter.items)}[]`;
  if (parameter.type) return typeExpression({ type: parameter.type, format: parameter.format, enum: parameter.enum });
  return 'unknown';
}

function parameterDisplayType(parameter: JsonObject): string {
  // `string /* uuid */` → `string (uuid)` for compact list rendering
  return parameterType(parameter).replace(/\/\*\s*([^*]+?)\s*\*\//g, '($1)');
}

function parameterDefault(parameter: JsonObject): unknown {
  if (parameter.default !== undefined) return parameter.default;
  if (isObject(parameter.schema)) return parameter.schema.default;
  return undefined;
}

function isMeaningfulDefault(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

export function parameterList(parameters: JsonObject[], style: RenderStyle = FULL_STYLE): string {
  if (!parameters.length) return '_None._';
  if (style.collapsed) {
    return `- _${parameters.length} parameter${parameters.length === 1 ? '' : 's'} (detail collapsed for token budget)._`;
  }
  return parameters
    .map((parameter) => {
      const required = parameter.required === true || parameter.in === 'path';
      const type = parameterDisplayType(parameter);
      const defaultValue = parameterDefault(parameter);
      const defaultSuffix = isMeaningfulDefault(defaultValue)
        ? ` (default: ${typeof defaultValue === 'string' ? JSON.stringify(defaultValue) : String(defaultValue)})`
        : '';
      const description = shortenDescription(cleanText(parameter.description), style.descriptionLimit);
      const details = description ? ` — ${description}` : '';
      return `- \`${cleanText(parameter.name)}\` (\`${cleanText(parameter.in)}\`${required ? ', required' : ''}) · \`${type}\`${defaultSuffix}${details}`;
    })
    .join('\n');
}

export function requestPayloadDescription(
  spec: JsonObject,
  operation: JsonObject,
  style: RenderStyle = FULL_STYLE,
): PayloadDescription | undefined {
  if (isObject(operation.requestBody) || operation.requestBody?.$ref) {
    const body = resolveReferenceObject(spec, operation.requestBody);
    const content = isObject(body.content) ? body.content : {};
    const mediaType = chooseMediaType(content);
    const media = mediaType ? content[mediaType] : undefined;
    const schema = isObject(media?.schema) ? media.schema : undefined;
    return {
      type: schema ? typeExpression(schema) : 'unknown',
      mediaType: mediaType || 'unknown media type',
      example: style.includeExamples && (media || schema) ? payloadExample(spec, media, schema) : undefined,
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
      example: style.includeExamples ? payloadExample(spec, undefined, bodyParameter.schema) : undefined,
      required: bodyParameter.required === true,
    };
  }
  return undefined;
}

export type { PayloadExample } from './examples.js';
