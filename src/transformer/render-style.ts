/**
 * Per-render detail controls used by the token-budget trimming pipeline.
 * The default (FULL_STYLE) reproduces the historical digest exactly.
 */
export interface RenderStyle {
  /** Stage (a): render declared request/response example payloads. */
  includeExamples: boolean;
  /** Stage (b): truncate descriptions longer than this many characters. */
  descriptionLimit?: number;
  /** Stage (c): collapse parameter/response detail for this endpoint. */
  collapsed: boolean;
}

export const FULL_STYLE: RenderStyle = { includeExamples: true, collapsed: false };

export function shortenDescription(text: string, limit: number | undefined): string {
  if (limit === undefined || text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}…`;
}
