import type { JsonObject } from '../types.js';
import { cleanText, entries, isObject, markdownCell } from './utils.js';
import { shortenDescription, type RenderStyle, FULL_STYLE } from './render-style.js';
import { chooseMediaType, formattedExample, payloadExample, type PayloadDescription } from './examples.js';
import { resolveReferenceObject, typeExpression } from './schema-type.js';

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

export function responseSchema(
  spec: JsonObject,
  responseValue: unknown,
  style: RenderStyle = FULL_STYLE,
): PayloadDescription {
  const response = resolveReferenceObject(spec, responseValue);
  if (isObject(response.content)) {
    const mediaType = chooseMediaType(response.content);
    const media = mediaType ? response.content[mediaType] : undefined;
    const schema = isObject(media?.schema) ? media.schema : undefined;
    return {
      type: schema ? typeExpression(schema) : undefined,
      mediaType,
      example:
        style.includeExamples && (schema || media) ? payloadExample(spec, media, schema, response.examples) : undefined,
    };
  }
  if (isObject(response.schema)) {
    return {
      type: typeExpression(response.schema),
      mediaType: 'application/json',
      example: style.includeExamples ? payloadExample(spec, undefined, response.schema, response.examples) : undefined,
    };
  }
  return {};
}

function responseBlock(
  spec: JsonObject,
  code: string,
  responseValue: unknown,
  style: RenderStyle = FULL_STYLE,
): string {
  const response = resolveReferenceObject(spec, responseValue);
  const description = style.collapsed
    ? ''
    : shortenDescription(cleanText(response.description), style.descriptionLimit);
  const payload = responseSchema(spec, responseValue, style);
  const suffix = payload.type
    ? ` — \`${payload.type}\`${payload.mediaType ? ` (${payload.mediaType})` : ''}`
    : ' — no body schema declared';
  if (style.collapsed) {
    return [`- **${markdownCell(code)}**${suffix}`].join('\n');
  }
  const lines = [`- **${markdownCell(code)}${description ? ` ${description}` : ''}**${suffix}`];
  // Only spec-declared examples are rendered; synthetic mocks duplicate the
  // TypeScript interfaces in ## Data types and waste context window.
  if (payload.example?.origin === 'declared') {
    const label = payload.example.name ? ` · ${payload.example.name}` : '';
    lines.push(
      '',
      `  **Example Value** *(declared in the spec${label})*`,
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

const COLLAPSIBLE_ERROR_CODES = new Set(['400', '401', '403', '404', '500', '502', '503']);

const GENERIC_ERROR_DESCRIPTIONS = new Set([
  '',
  'an error occurred',
  'bad gateway',
  'bad request',
  'client error',
  'error',
  'failed',
  'forbidden',
  'internal error',
  'internal server error',
  'invalid request',
  'not found',
  'payment required',
  'request error',
  'request failed',
  'server error',
  'service unavailable',
  'too many requests',
  'unauthorized',
  'unexpected error',
  'unknown error',
]);

function isGenericErrorDescription(description: string): boolean {
  if (!description) return true;
  return GENERIC_ERROR_DESCRIPTIONS.has(
    description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim(),
  );
}

function responseSchemaValue(spec: JsonObject, responseValue: unknown): unknown | undefined {
  const response = resolveReferenceObject(spec, responseValue);
  if (isObject(response.content)) {
    const mediaType = chooseMediaType(response.content);
    const media = mediaType ? response.content[mediaType] : undefined;
    return isObject(media?.schema) ? media.schema : undefined;
  }
  if (isObject(response.schema)) return response.schema;
  return undefined;
}

/**
 * Standard error codes with a generic description, no custom headers and no
 * spec-authored example are boilerplate and collapse into one `Errors` line,
 * regardless of whether their payload schemas are structurally identical.
 * Returns the collapsed entry for this code, or undefined when the response is
 * distinctive enough to deserve its own detailed block.
 */
function collapsibleErrorEntry(spec: JsonObject, code: string, responseValue: unknown): string | undefined {
  if (!COLLAPSIBLE_ERROR_CODES.has(code)) return undefined;
  const response = resolveReferenceObject(spec, responseValue);
  if (!isGenericErrorDescription(cleanText(response.description))) return undefined;
  if (isObject(response.headers) && Object.keys(response.headers).length) return undefined;
  if (responseSchema(spec, responseValue).example?.origin === 'declared') return undefined;
  const schemaValue = responseSchemaValue(spec, responseValue);
  if (schemaValue === undefined) return `\`${code}\``;
  return `\`${code}\` (\`${typeExpression(schemaValue)}\`)`;
}

export function responseSection(spec: JsonObject, operation: JsonObject, style: RenderStyle = FULL_STYLE): string {
  const responses = entries(operation.responses).filter(([, value]) => isObject(value));
  if (!responses.length) return '_No responses declared._';

  const success = responses.filter(([code]) => /^2\d\d$/.test(code));
  success.sort(([a], [b]) => (a === '200' ? -1 : b === '200' ? 1 : Number(a) - Number(b)));
  const errors = responses.filter(
    ([code]) =>
      (COMMON_ERROR_CODES.has(code) || /^([45])\d\d$/.test(code)) &&
      !success.some(([successCode]) => successCode === code),
  );

  if (style.collapsed) {
    const collapsedLines = success.map(([code, response]) => responseBlock(spec, code, response, style));
    collapsedLines.push(...errors.map(([code, responseValue]) => responseBlock(spec, code, responseValue, style)));
    return collapsedLines.join('\n');
  }

  const detailedErrors: string[] = [];
  const collapsedErrors: string[] = [];
  for (const [code, responseValue] of errors) {
    const entry = collapsibleErrorEntry(spec, code, responseValue);
    if (entry === undefined) detailedErrors.push(responseBlock(spec, code, responseValue, style));
    else collapsedErrors.push(entry);
  }

  const primarySuccess = success[0];
  const lines: string[] = primarySuccess ? [responseBlock(spec, primarySuccess[0], primarySuccess[1], style)] : [];
  lines.push(...detailedErrors);
  if (collapsedErrors.length) lines.push(`- **Errors:** ${collapsedErrors.join(', ')}`);

  if (success.length > 1) {
    const others = success.slice(1).map(([code, response]) => responseBlock(spec, code, response, style));
    lines.push('', '<details><summary>Other successful responses</summary>', '', ...others, '', '</details>');
  }
  if (!lines.length) {
    return responses.map(([code, response]) => responseBlock(spec, code, response, style)).join('\n\n');
  }
  return lines.join('\n');
}
