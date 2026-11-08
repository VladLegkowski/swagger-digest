# swagger-digest

`swagger-digest` is an interactive Node.js CLI that converts a Swagger UI page or raw OpenAPI/Swagger spec into a compact Markdown reference designed for AI coding agents and LLM context windows.

## Quick start

```bash
npx swagger-digest
```

The CLI asks for a URL, a destination directory (Downloads by default), and an output filename such as `payments-api-digest.md`.

You can also provide arguments:

```bash
npx swagger-digest \
  --url https://petstore.swagger.io/ \
  --out-dir ./docs \
  --filename petstore-digest.md
```

For a direct spec URL:

```bash
npx swagger-digest --url https://example.com/openapi.yaml --out-dir ./docs
```

If the Swagger UI initializer lists several spec definitions (`urls: [{ url, name }, …]`), the tool probes them in the order they appear and uses the first one that parses, printing a notice to stderr naming the pick and the alternatives. To choose a specific spec yourself, pass it explicitly:

```bash
npx swagger-digest --url https://api.example.com/swagger-ui \
  --spec https://api.example.com/v2/tenant-a.json --out-dir ./docs
```

`--spec` overrides all discovery: the given URL is fetched directly (with the same header scoping and size limits) and the Swagger UI page is never consulted when it parses successfully.

### Writing to stdout

```bash
npx swagger-digest --url https://petstore.swagger.io/ --stdout > petstore.md
npx swagger-digest --url https://api.example.com/openapi.json --stdout | pbcopy
```

`--stdout` prints the digest to standard output instead of saving a file — handy for piping into other tools or copying to the clipboard. Progress and warnings go to stderr, so the pipe receives only the Markdown. `--stdout` cannot be combined with `--out-dir` or `--filename`; the CLI exits with a clear error if you try.

Run `npx swagger-digest --help` for all CLI options. The package requires Node.js 20 or newer.

## MCP server

The package ships an [MCP](https://modelcontextprotocol.io) server exposing the same pipeline as a tool for AI agents, so they can fetch and digest API docs on their own instead of being handed a Markdown file.

```bash
npx swagger-digest-mcp
```

It speaks the stdio transport: the MCP client spawns the process and communicates over stdin/stdout. Register it in your client's configuration:

```json
{
  "mcp": {
    "swagger-digest": {
      "command": ["npx", "-y", "swagger-digest-mcp"]
    }
  }
}
```

### The `swagger_digest` tool

| Argument        | Type             | Description                                                                |
| --------------- | ---------------- | -------------------------------------------------------------------------- |
| `url`           | string, required | Swagger UI page URL or direct OpenAPI spec URL                             |
| `spec_url`      | string, optional | Explicit spec URL; overrides discovery from the page                       |
| `headers`       | object, optional | Request headers (e.g. `Authorization`); sent only to the origin of `url`   |
| `include_tags`  | string[]         | Keep only operations with these tags                                       |
| `exclude_tags`  | string[]         | Drop operations with these tags                                            |
| `path_prefix`   | string           | Keep only paths starting with this prefix                                  |
| `max_tokens`    | number           | Trim the digest to an approximate token budget                             |
| `write_to_file` | object, optional | `{ directory, filename }` — save the digest instead of returning it inline |

By default the digest is returned directly in the tool result (so it lands in the agent's context), with a metadata footer: retrieval method, operation/model counts, and a token estimate.

### Environment variables

- `SWAGGER_DIGEST_HEADER` — newline-separated `Name: value` pairs, merged with (and overridden by) the tool call's `headers` argument. Keeps secrets out of the conversation.
- `SWAGGER_DIGEST_ALLOW_PRIVATE=1` — opt out of the private-network guard (see below).

### Security differences from the CLI

- **SSRF guard on by default:** URLs resolving to loopback, private, or link-local (cloud metadata) addresses are rejected, because MCP clients supply URLs on the model's behalf. Opt out with `SWAGGER_DIGEST_ALLOW_PRIVATE=1` — for example to digest an internal corporate API — only if you trust the hosts involved.
- **No headless-browser fallback:** the optional Playwright fallback is disabled in the MCP server.
- Diagnostics go to stderr only; stdout carries protocol frames exclusively.

## Benchmarks

Ten public APIs, digest vs. raw spec JSON in an LLM context, ground truth from the parsed raw specs. Run in November 2026 against swagger-digest 0.2.0; token counts are heuristic estimates, not tokenizer-exact.

**7/10 wins · 100% operation coverage on every digest produced · 1.6–3.7× lighter · 1 call vs 1–5**

| Spec                | Ops   | Raw tokens             | Digest tokens           | Compression | Op coverage | Winner  |
| ------------------- | ----- | ---------------------- | ----------------------- | ----------- | ----------- | ------- |
| Petstore v2         | 20    | 3,461                  | 2,202                   | 1.6×        | 20/20       | 🟢 MCP  |
| Petstore v3         | 19    | 4,277                  | 2,624                   | 1.6×        | 19/19       | 🟢 MCP  |
| Petstore v3 UI page | 19    | 4,277 (+4 URL guesses) | ❌ failed*              | —           | —           | 🟡 Raw* |
| Azure Compute       | 157   | 157,568                | 72,549                  | 2.2×        | 157/157     | 🟢 MCP  |
| X/Twitter v2        | 259   | 333,985                | 105,719                 | 3.2×        | 259/259     | 🟢 MCP  |
| Box                 | 297   | 453,200                | 162,829                 | 2.8×        | 297/297     | 🟢 MCP  |
| Twilio              | 197   | 469,913                | 155,709                 | 3.0×        | 197/197     | 🟢 MCP  |
| Stripe              | 612   | 2,079,211              | 564,308                 | 3.7×        | 612/612     | 🟢 MCP  |
| Kubernetes          | 1,172 | 1,085,939              | 1,341,885 (expanded!)   | ❌ 0.8×*    | 1172/1172   | 🔴 Raw  |
| GitHub (full)       | 1,272 | 3,551,639              | ❌ failed (14 MB fetch) | —           | —           | 🟡 Raw* |

> For its target use case — understanding an API in an LLM context — the digest wins on the spec class that actually matters (up to ~600 operations): 100% endpoint coverage, never truncated, one call, and 1.6–3.7× lighter. The bigger the spec, the bigger the win.

\* Raw's three "wins" carry heavy caveats: the Petstore UI-page case needed brute-forced candidate URLs (the digest's discovery has since been fixed for that class of pages); GitHub's 3.55M-token raw spec would truncate in any model's context anyway; and the Kubernetes expansion is now prevented by the default token cap described below.

### Known failure modes (and their mitigations)

| Case                                                         | What happens                                                           | Mitigation                                                                                                                             |
| ------------------------------------------------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| JS-only Swagger UI pages with dynamically computed spec URLs | Literal extraction finds nothing after `url:`                          | **Fixed in 0.3.0** (embedded spec-URL scan). Otherwise pass `spec_url` / `--spec` explicitly                                           |
| Mega-specs (Kubernetes-class, ≥1M tokens)                    | Digest can _expand_ past raw size — descriptions inlined per operation | **Default in 0.3.0**: automatic 250k-token cap (opt out with `--no-auto-trim` / `auto_trim: false`). Explicit `max_tokens` always wins |
| Huge fetches (14 MB GitHub spec)                             | Fetch fails at the 10 MB response cap                                  | Use a filtered direct spec URL                                                                                                         |

### Filtering and token budget

Large specs produce large digests. The CLI can remove whole operations before rendering and/or trim the remaining digest to an approximate token budget:

```bash
# Keep only operations tagged "Payments", plus everything under /invoices
npx swagger-digest --url https://api.example.com/openapi.json \
  --include-tag Payments --path-prefix /payments/ --out-dir ./docs

# Drop a noisy tag
npx swagger-digest --url https://api.example.com/openapi.json --exclude-tag Internal

# Fit the digest into a model's context window
npx swagger-digest --url https://api.example.com/openapi.json --max-tokens 50000
```

How `--max-tokens` trims (in this fixed order, re-checked against the estimate after each step):

1. Drop declared example payloads (synthetic examples are never emitted).
2. Shorten long descriptions.
3. Collapse parameter/response detail per tag — the **tag priority rule** is that the tag appearing **last in the document** is collapsed first (lowest priority), one tag per step.
4. Keep only the Quick index entries (no endpoint detail, no data types).

A `## Trimmed` note at the end of the digest records exactly which steps were applied. After every step, schemas that became unreachable (referenced only by collapsed/removed operations) are dropped from the Data types section. The token estimator is a heuristic, **not** a real tokenizer — treat `--max-tokens` as a guide, not a guarantee. Unknown tag names passed to `--include-tag`/`--exclude-tag` produce a warning on stderr listing the tags that exist in the spec.

**Default token cap:** without an explicit `--max-tokens`, digests are automatically trimmed to an estimated 250,000 tokens (a warning names the untrimmed estimate). Mega-specs can otherwise expand _past_ their raw size once descriptions are inlined per operation. Opt out with `--no-auto-trim`; an explicit `--max-tokens` always takes precedence. The MCP server behaves the same via its `auto_trim` argument (default true).

The same options are available programmatically via the third argument of `transformOpenApiToMarkdown(spec, sourceUrl, { includeTags, excludeTags, pathPrefix, maxTokens, onWarning })`.

## What it extracts

The retrieval strategy deliberately avoids scraping rendered operation accordions or simulating UI clicks:

1. Fetch and parse a direct `.json`, `.yaml`, or `.yml` URL.
2. Fetch the Swagger UI page and inspect script configuration for `url: "..."` or an inline `spec: { ... }` object, plus any spec-like URLs embedded in same-origin initializer scripts (covers initializers that compute the spec URL dynamically).
3. Try common spec endpoints on the same origin: `/v3/api-docs`, `/swagger/v1/swagger.json`, `/swagger.json`, `/openapi.json`, and `/api-docs`.
4. Optionally launch a headless Chromium browser and read the parsed specification from Swagger UI's in-memory state.

The first three paths use ordinary HTTP requests. The browser fallback is optional so the normal install stays lightweight. To enable it for a difficult JavaScript-initialized Swagger UI deployment:

```bash
npm install playwright
npx playwright install chromium
```

Then run the CLI again. Use `--no-browser` to disable the fallback.

### Authentication headers

Some Swagger UI pages and spec URLs live behind authentication. Pass custom headers with `-H`/`--header` (repeatable) or `--cookie`:

```bash
npx swagger-digest \
  --url https://api.example.com/swagger-ui \
  --header "Authorization: Bearer eyJhbGciOi..." \
  --out-dir ./docs
```

Or with a session cookie:

```bash
npx swagger-digest --url https://api.example.com/swagger-ui --cookie "session=abc123"
```

You can also supply headers through the `SWAGGER_DIGEST_HEADER` environment variable, with one `Name: value` pair per line. `-H` flags override environment entries on conflicting header names:

```bash
export SWAGGER_DIGEST_HEADER=$'Authorization: Bearer eyJ…\nX-Tenant: acme'
npx swagger-digest --url https://api.example.com/swagger-ui
```

**Scoping and safety:**

- Custom headers are sent **only** to the origin of the URL you supply. If the discovered spec, a redirect, or a Swagger UI script lives on a different origin, that request is made without your headers and a warning naming the other origin is printed to stderr.
- In the headless-browser fallback, headers are injected per-request (only for your origin) — they never reach CDNs or third-party scripts loaded by the page.
- Header values are never logged, written to the digest, or included in error messages.
- ⚠️ **Shell history:** secrets passed with `-H` can end up in your shell history file (`~/.bash_history`, `~/.zsh_history`). Prefer the `SWAGGER_DIGEST_HEADER` environment variable, or prefix the command with a space if your shell is configured to ignore leading-space entries.

### Troubleshooting access through a VPN

The ordinary HTTP fetches use Node.js networking; they do not automatically reuse a browser's VPN extension, cookies, or signed-in session. If the Swagger page works in Chrome but not in the CLI, first test the same URL from the terminal:

```bash
curl -v -L 'https://your-host.example/path/to/swagger-ui' -o /tmp/swagger-page.html
```

If `curl` cannot connect or receives `401`/`403`, connect a system-level VPN that also routes terminal applications, or configure the relevant corporate proxy/authentication for the terminal. Installing Playwright alone does not make a browser-only VPN extension available to its separate Chromium instance. If terminal access succeeds, the extractor now also reads same-origin Swagger UI initializer/config scripts and tries spec paths relative to the supplied page's context path.

## Security notes

**What the tool fetches:** the URL you supply (a Swagger UI page or direct OpenAPI JSON/YAML URL), same-origin Swagger UI initializer/config scripts, the spec URL referenced by that page, and a short list of common spec paths on the same origin (`/v3/api-docs`, `/swagger.json`, …). The optional Playwright fallback loads the same page in a headless browser.

**What it does not forward:** cookies or Authorization headers are never sent automatically. Custom headers you pass with `--header`/`--cookie` (see below) are sent **only** to the origin of the URL you supplied. If the page redirects to another origin, or the discovered spec lives on a different origin, those requests are made without your headers and a warning naming the other origin is printed to stderr. Response bodies are capped (10 MB by default, configurable with `--max-bytes`), and redirects are followed at most 5 times.

**Embedding in a server:** if you call `fetchOpenApiSpec` from a server that accepts user-supplied URLs, enable `blockPrivateNetworks: true` in the fetch options. Without it, a caller can point the tool at `http://169.254.169.254/…` or other internal addresses from your infrastructure (SSRF). The check rejects loopback, link-local (including the cloud-metadata address 169.254.169.254), private, and unique-local addresses, and applies after redirects. Note the documented DNS-rebinding limitation in the code — for hostile multi-tenant input, use a dedicated egress proxy.

## Markdown format

The generated document includes:

- API title, OpenAPI/Swagger version, API version, base URL(s), and authentication schemes.
- A compact endpoint index (`Method`, `Path`, `Summary`, and `Tags`).
- Endpoint details grouped by tag, including auth requirements, path/query/header parameters, request bodies, success/error responses, and JSON example values.
- TypeScript-like interface/type declarations for schemas reachable from the documented operations, with local `$ref` dependencies expanded as named type references rather than copied JSON Schema trees.

OpenAPI 2.0, 3.0, and 3.1 documents are handled through format normalization in the transformer. Schema combinations (`allOf`, `oneOf`, `anyOf`), enums, arrays, nullable fields, and `additionalProperties` receive compact TypeScript-like representations. Unknown or unsupported schema constructs are represented as `unknown` rather than causing the entire digest to fail.

## Development

```bash
npm install
npm run build
npm test
npm run lint
npm link
swagger-digest
```

Test against the public Petstore UI:

```bash
npm run build
node dist/cli.js --url https://petstore.swagger.io/ --out-dir ./tmp --filename petstore-digest.md
```

The test suite runs locally against fixtures and does not require a network connection. Network-based checks such as the Petstore example depend on that service being reachable from your environment.

## Project layout

```text
src/
  cli.ts          CLI entry point, prompts, options and progress spinners
  fetcher.ts      HTTP, HTML configuration parsing and optional browser fallback
  transformer.ts  OpenAPI/Swagger to compact Markdown and TypeScript-like types
  writer.ts       Output path, filename defaults and file writing
  index.ts        Public exports
  mcp/
    index.ts      MCP stdio entry point (`swagger-digest-mcp` bin)
    server.ts     MCP server and tool registration (transport-agnostic)
    digest.ts     Tool handler: fetch → transform → tool result
```

## Limitations

- The tool downloads specs exposed by the supplied server. It does not bypass authentication, browser access controls, or network restrictions.
- External `$ref` documents are bundled best-effort: references to other HTTP(S) documents are fetched (one level deep, at most 5 documents) and their schemas inlined under namespaced names such as `meta_SharedMeta`. If an external document is unreachable or unparsable, the reference degrades to a named type reference and the digest still succeeds.
- Declared request/response examples are preserved. When an example is absent but a schema exists, a representative JSON example is generated from that schema and clearly marked as illustrative rather than spec-authored. The transformer includes the primary success response and applicable common error responses to balance useful payload context against digest size.
- A generated digest is a compact developer reference, not a replacement for the source OpenAPI contract.

## License

MIT
