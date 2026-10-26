import type { JsonObject } from '../types.js';
import { cleanText, isObject, markdownCell, toTypeScriptIdentifier } from './utils.js';
import { shortenDescription, type RenderStyle, FULL_STYLE } from './render-style.js';
import { resolveReferenceObject } from './schema-type.js';
import { mergedParameters, parameterList, requestPayloadDescription } from './parameters.js';
import { formattedExample } from './examples.js';
import { responseSection } from './responses.js';
import { securityRequirement } from './security.js';

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface Endpoint {
  method: HttpMethod;
  path: string;
  operation: JsonObject;
  pathParameters: JsonObject[];
  tag: string;
}

export function getEndpoints(spec: JsonObject): Endpoint[] {
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

export function getServers(spec: JsonObject): string[] {
  if (Array.isArray(spec.servers) && spec.servers.length) {
    return spec.servers.map((server: unknown) => cleanText(isObject(server) ? server.url : undefined)).filter(Boolean);
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

export function collectTags(spec: JsonObject, endpoints: Endpoint[]): string[] {
  const declared = Array.isArray(spec.tags)
    ? spec.tags.map((tag: unknown) => cleanText(isObject(tag) ? tag.name : undefined)).filter(Boolean)
    : [];
  const encountered = [...new Set(endpoints.map((endpoint) => endpoint.tag))];
  return [
    ...declared.filter((tag: string) => encountered.includes(tag)),
    ...encountered.filter((tag) => !declared.includes(tag)),
  ];
}

export function endpointTypeBase(method: string, path: string, operation: JsonObject): string {
  if (cleanText(operation.operationId)) return toTypeScriptIdentifier(cleanText(operation.operationId));
  const pathName = path
    .replace(/[{}]/g, '')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return toTypeScriptIdentifier(`${method.charAt(0).toUpperCase()}${method.slice(1)}${pathName}`);
}

export function shortOperationDescription(operation: JsonObject): string {
  return markdownCell(operation.summary || operation.operationId || operation.description || '—');
}

export function endpointMarkdown(spec: JsonObject, endpoint: Endpoint, style: RenderStyle = FULL_STYLE): string {
  const { operation, method, path } = endpoint;
  const heading = `#### \`${method.toUpperCase()} ${path}\``;
  const summary = cleanText(operation.summary);
  const description = cleanText(operation.description);
  const lines = [heading];
  if (summary) lines.push('', shortenDescription(summary, style.descriptionLimit));
  if (description && description !== summary) {
    lines.push('', shortenDescription(description, style.descriptionLimit));
  }
  lines.push('', `**Authentication:** ${securityRequirement(spec, operation)}`);

  const parameters = mergedParameters(spec, endpoint);
  const request = requestPayloadDescription(spec, operation, style);
  lines.push('', '**Parameters**');
  lines.push(parameterList(parameters, style));
  if (request) {
    lines.push(
      '',
      `**Request body:** \`${request.mediaType}\` → \`${request.type}\`${request.required ? ' (required)' : ' (optional)'}`,
    );
    // Only spec-declared request examples are rendered; synthetic mocks
    // duplicate the TypeScript interfaces in ## Data types.
    if (request.example?.origin === 'declared') {
      const label = request.example.name ? ` · ${request.example.name}` : '';
      lines.push(
        '',
        `**Request Example Value** *(declared in the spec${label})*`,
        '',
        '```json',
        formattedExample(request.example.value),
        '```',
      );
    }
  }
  lines.push('', '**Responses**', responseSection(spec, operation, style));
  return lines.join('\n');
}
