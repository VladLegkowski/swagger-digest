export type JsonObject = Record<string, any>;

export interface FetchOptions {
  timeoutMs?: number;
  useBrowserFallback?: boolean;
  /** Maximum response body size in bytes (default 10 MB). */
  maxBytes?: number;
  /** Maximum number of redirects to follow (default 5). */
  maxRedirects?: number;
  /** Opt-in: reject hostnames resolving to private/loopback/metadata addresses. */
  blockPrivateNetworks?: boolean;
  /** Timeout for fallback-path probes (default 5000ms; main requests use timeoutMs). */
  probeTimeoutMs?: number;
  /**
   * Custom request headers (e.g. Authorization or Cookie). These are sent ONLY
   * to the origin of the URL passed to fetchOpenApiSpec; cross-origin requests
   * (including cross-origin redirects and third-party browser requests) never
   * receive them.
   */
  headers?: Record<string, string>;
  /** Receives non-fatal notices, e.g. headers withheld on a cross-origin fetch. */
  warn?: (message: string) => void;
  /**
   * Explicit spec URL that overrides discovery entirely: it is fetched first
   * (with the same header scoping as the main URL) and the page is never
   * consulted when it parses successfully.
   */
  specUrl?: string;
}

export interface FetchResult {
  spec: JsonObject;
  sourceUrl: string;
  retrievalMethod: 'direct-spec' | 'html-config' | 'inline-spec' | 'fallback-path' | 'headless-browser';
}
