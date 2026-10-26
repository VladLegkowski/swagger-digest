export type JsonObject = Record<string, any>;

export interface FetchOptions {
  timeoutMs?: number;
  useBrowserFallback?: boolean;
}

export interface FetchResult {
  spec: JsonObject;
  sourceUrl: string;
  retrievalMethod: 'direct-spec' | 'html-config' | 'inline-spec' | 'fallback-path' | 'headless-browser';
}
