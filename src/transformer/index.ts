import type { JsonObject } from '../types.js';
import { cleanText, isObject, markdownCell, safeSourceUrl } from './utils.js';
import { authOverview } from './security.js';
import {
  collectTags,
  endpointMarkdown,
  getEndpoints,
  getServers,
  shortOperationDescription,
  type Endpoint,
} from './endpoints.js';
import { modelDeclaration, normalizeInlinePayloadSchemas, referencedSchemas } from './models.js';
import { estimateTokens } from '../tokens.js';

export interface TransformOptions {
  /** Keep only operations carrying at least one of these tags. Repeatable. */
  includeTags?: string[];
  /** Drop operations carrying any of these tags. Repeatable. */
  excludeTags?: string[];
  /** Keep only operations whose path starts with this prefix. */
  pathPrefix?: string;
  /**
   * Trim the digest until the (approximate, heuristic) token estimate fits this
   * budget. The estimator is not tokenizer-accurate; treat the budget as a guide.
   */
  maxTokens?: number;
  /** Receives non-fatal notices, e.g. unknown tag names. */
  onWarning?: (message: string) => void;
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

interface TrimStage {
  includeExamples: boolean;
  descriptionLimit?: number;
  collapsedTags: ReadonlySet<string>;
  indexOnly: boolean;
  /** Human-readable description of what this stage removes, for the Trimmed note. */
  action?: string;
}

function tagsOfEndpoint(endpoint: Endpoint): string[] {
  const tags = endpoint.operation.tags;
  return Array.isArray(tags) && tags.length ? tags.map(String) : ['General'];
}

/**
 * Filters operations by include/exclude tags and path prefix. Unknown tag
 * names produce a warning listing the available tags. Because referenced
 * schemas are collected from the kept paths only, models used exclusively by
 * excluded operations are not emitted.
 */
function filterSpec(
  spec: JsonObject,
  endpoints: Endpoint[],
  options: TransformOptions,
  warnings: string[],
): JsonObject {
  const includeTags = options.includeTags ?? [];
  const excludeTags = options.excludeTags ?? [];
  const hasFilter = includeTags.length > 0 || excludeTags.length > 0 || options.pathPrefix !== undefined;
  if (!hasFilter) return spec;

  const declared = Array.isArray(spec.tags)
    ? spec.tags.map((tag: unknown) => (isObject(tag) && typeof tag.name === 'string' ? tag.name : '')).filter(Boolean)
    : [];
  const available = [...new Set([...declared, ...endpoints.map((endpoint) => endpoint.tag)])];

  const unknownTags = [
    ...includeTags.filter((tag) => !available.includes(tag)),
    ...excludeTags.filter((tag) => !available.includes(tag)),
  ];
  if (unknownTags.length > 0) {
    warnings.push(
      `Unknown tag(s): ${[...new Set(unknownTags)].join(', ')}. Available tags: ${available.join(', ') || 'none'}.`,
    );
  }

  const keep = (endpoint: Endpoint): boolean => {
    if (options.pathPrefix && !endpoint.path.startsWith(options.pathPrefix)) return false;
    const tags = tagsOfEndpoint(endpoint);
    if (includeTags.length > 0 && !tags.some((tag) => includeTags.includes(tag))) return false;
    if (excludeTags.length > 0 && tags.some((tag) => excludeTags.includes(tag))) return false;
    return true;
  };

  const paths: JsonObject = {};
  for (const endpoint of endpoints.filter(keep)) {
    const source = isObject((spec.paths as JsonObject | undefined)?.[endpoint.path])
      ? ((spec.paths as JsonObject)[endpoint.path] as JsonObject)
      : {};
    const item = (paths[endpoint.path] as JsonObject | undefined) ?? { ...source };
    // Remove every method first so only kept operations remain on the path item.
    for (const method of HTTP_METHODS) delete item[method];
    item[endpoint.method] = source[endpoint.method];
    paths[endpoint.path] = item;
  }
  return { ...spec, paths };
}

/**
 * Deterministic trimming stages of increasing damage:
 * 1. full digest
 * (a) drop declared example payloads
 * (b) shorten long descriptions
 * (c) collapse parameter/response detail per tag, lowest-priority first
 *     (tags are collapsed last-document-position first, one tag per stage)
 * (d) keep only the Quick index entries for the remaining tags
 */
function buildTrimStages(_endpoints: Endpoint[], tags: string[]): TrimStage[] {
  const stages: TrimStage[] = [];
  const emptyTags: ReadonlySet<string> = new Set();

  stages.push({
    includeExamples: true,
    collapsedTags: emptyTags,
    indexOnly: false,
  });

  stages.push({
    includeExamples: false,
    collapsedTags: emptyTags,
    indexOnly: false,
    action: 'removed declared example payloads',
  });

  stages.push({
    includeExamples: false,
    descriptionLimit: 200,
    collapsedTags: emptyTags,
    indexOnly: false,
    action: 'shortened long descriptions',
  });

  // Collapse tag groups from the lowest priority (last in document order) upward.
  const collapsedSoFar = new Set<string>();
  for (const tag of [...tags].reverse()) {
    collapsedSoFar.add(tag);
    stages.push({
      includeExamples: false,
      descriptionLimit: 200,
      collapsedTags: new Set(collapsedSoFar),
      indexOnly: false,
      action: `collapsed parameter and response detail for tag "${tag}"`,
    });
  }

  stages.push({
    includeExamples: false,
    descriptionLimit: 200,
    collapsedTags: new Set(tags),
    indexOnly: true,
    action: 'kept only the Quick index entries for the remaining tags',
  });
  return stages;
}

function renderDigest(
  spec: JsonObject,
  sourceUrl: string | undefined,
  endpoints: Endpoint[],
  tags: string[],
  stage: TrimStage,
): string {
  const info = isObject(spec.info) ? spec.info : {};
  const title = cleanText(info.title) || 'API';
  const version = cleanText(info.version) || 'unspecified';
  const openApiVersion = cleanText(spec.openapi) || (spec.swagger ? `Swagger ${spec.swagger}` : 'OpenAPI');
  const servers = getServers(spec);
  const indexRows = endpoints.map(
    (endpoint) =>
      `| **${endpoint.method.toUpperCase()}** | \`${markdownCell(endpoint.path)}\` | ${shortOperationDescription(endpoint.operation)} | ${markdownCell(Array.isArray(endpoint.operation.tags) ? endpoint.operation.tags.join(', ') : endpoint.tag)} |`,
  );

  const detailEndpoints = stage.indexOnly ? [] : endpoints.filter((endpoint) => !stage.collapsedTags.has(endpoint.tag));

  const groupedEndpoints = tags
    .map((tag) => {
      const members = endpoints.filter((endpoint) => endpoint.tag === tag);
      if (!members.length) return '';
      const rendered = members.map((endpoint) =>
        endpointMarkdown(spec, endpoint, {
          includeExamples: stage.includeExamples,
          descriptionLimit: stage.descriptionLimit,
          collapsed: stage.collapsedTags.has(endpoint.tag),
        }),
      );
      return [`### ${tag}`, ...rendered].join('\n\n');
    })
    .filter(Boolean);

  // Schemas reachable from endpoints that still render full detail only —
  // models used exclusively by collapsed or index-only operations are dropped.
  let modelSpec: JsonObject = spec;
  if (detailEndpoints.length !== endpoints.length) {
    const scopedPaths: JsonObject = {};
    for (const endpoint of detailEndpoints) {
      const source = isObject((spec.paths as JsonObject | undefined)?.[endpoint.path])
        ? (spec.paths as JsonObject)[endpoint.path]
        : {};
      const item = (scopedPaths[endpoint.path] as JsonObject | undefined) ?? { ...source };
      for (const method of HTTP_METHODS) delete item[method];
      item[endpoint.method] = source[endpoint.method];
      scopedPaths[endpoint.path] = item;
    }
    modelSpec = { ...spec, paths: scopedPaths };
  }
  const models = referencedSchemas(modelSpec);
  const modelSection =
    !stage.indexOnly && models.length
      ? [
          '## Data types',
          '',
          '```typescript',
          models.map(([name, schema]) => modelDeclaration(name, schema)).join('\n\n'),
          '```',
        ].join('\n')
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
  ];

  if (!stage.indexOnly) {
    sections.push(
      '',
      '## Endpoints',
      '',
      ...(groupedEndpoints.length ? groupedEndpoints : ['_No endpoints declared._']),
    );
  }
  if (modelSection) {
    sections.push('', modelSection);
  }

  return `${sections
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;
}

function appendTrimNote(markdown: string, actions: string[], budget: number): string {
  return `${markdown}
## Trimmed

> _Trimmed to fit the ~${budget.toLocaleString()}-token budget: ${actions.join('; ')}._
`;
}

/** Convert an OpenAPI 2.0, 3.0, or 3.1 document to a compact Markdown digest. */
export function transformOpenApiToMarkdown(
  spec: JsonObject,
  sourceUrl?: string,
  options: TransformOptions = {},
): string {
  // 1. Optional tag/path filtering. Removing operations here also removes the
  // schemas only they referenced from the Data types section.
  const warnings: string[] = [];
  const filteredSpec = filterSpec(spec, getEndpoints(spec), options, warnings);
  for (const message of warnings) options.onWarning?.(message);

  const normalizedSpec = normalizeInlinePayloadSchemas(filteredSpec);
  const endpoints = getEndpoints(normalizedSpec);
  const tags = collectTags(normalizedSpec, endpoints);

  const fullStage: TrimStage = {
    includeExamples: true,
    collapsedTags: new Set(),
    indexOnly: false,
  };
  if (options.maxTokens === undefined) {
    return renderDigest(normalizedSpec, sourceUrl, endpoints, tags, fullStage);
  }

  const worst = (markdown: string): number => {
    const report = estimateTokens(markdown);
    return Math.max(...Object.values(report.models).map((model) => model.tokens));
  };
  const fits = (markdown: string): boolean => worst(markdown) <= options.maxTokens!;

  const full = renderDigest(normalizedSpec, sourceUrl, endpoints, tags, fullStage);
  if (fits(full)) return full;

  const stages = buildTrimStages(endpoints, tags);
  for (let i = 1; i < stages.length; i += 1) {
    const stage = stages[i]!;
    const markdown = renderDigest(normalizedSpec, sourceUrl, endpoints, tags, stage);
    if (fits(markdown)) {
      return appendTrimNote(
        markdown,
        stages
          .slice(1, i + 1)
          .map((entry) => entry.action)
          .filter((action): action is string => Boolean(action)),
        options.maxTokens!,
      );
    }
  }
  // Even the most aggressive stage does not fit; return it with the full note.
  const last = stages[stages.length - 1]!;
  const markdown = renderDigest(normalizedSpec, sourceUrl, endpoints, tags, last);
  const allActions = stages
    .slice(1)
    .map((stage) => stage.action)
    .filter((action): action is string => Boolean(action));
  return appendTrimNote(markdown, allActions, options.maxTokens);
}

export { toTypeScriptIdentifier } from './utils.js';
