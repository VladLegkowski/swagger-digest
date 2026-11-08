<img width="1376" height="768" alt="Image" src="https://github.com/user-attachments/assets/6a9e4eb3-fea8-47b3-9296-e57b4a702c7c" />

# swagger-digest

[![npm version](https://img.shields.io/npm/v/swagger-digest)](https://www.npmjs.com/package/swagger-digest)
[![license](https://img.shields.io/npm/l/swagger-digest)](https://github.com/VladLegkowski/swagger-digest)
[![node](https://img.shields.io/badge/node-%3E%3D20-blue)](https://www.npmjs.com/package/swagger-digest)
[![MCP server](https://img.shields.io/badge/MCP-server-8a5cf5)](https://modelcontextprotocol.io)

**An API context engine for AI coding agents.** Turn large Swagger/OpenAPI specifications into compact, structured, searchable API context — as Markdown digests or through an on-demand MCP server.

A 600-operation spec like Stripe's is ~2M tokens of raw JSON — several times most models' context windows, and mostly noise even when it fits. swagger-digest reduces it to ~560k tokens of structured Markdown (benchmark below), and its MCP server lets your agent pull in only the endpoints and schemas it needs, when it needs them.

## The problem

- Real specifications contain hundreds of endpoints and thousands of lines of JSON/YAML.
- Pasting a raw spec into an AI coding agent burns context on boilerplate — descriptions repeated per operation, example payloads, schema trees.
- Finding the endpoints relevant to your task — and understanding their parameters and response shapes — means manually wading through the contract.
- Agents generating frontend code need accurate API contracts. Guessing field names from partial context produces broken integrations.

swagger-digest solves this at two levels: a **digest** (compact, complete, token-budgeted Markdown) and an **MCP server** (on-demand API context for agents).

## Two ways to use it

### Option 1: MCP server — recommended for AI coding agents

Run it as an [MCP](https://modelcontextprotocol.io) server and your agent explores APIs on its own: it calls the `swagger_digest` tool with a Swagger UI page or spec URL and receives a compact digest directly in its context — discovery, filtering and token budgets handled for it.

- **On-demand:** the agent fetches API context only when the task needs it.
- **Scoped:** filter to specific tags or paths so only relevant operations enter context.
- **Discovery built in:** point it at a Swagger UI page — it finds the spec automatically (initializer scripts, multi-spec dropdowns, common spec paths).
- **Ideal for ongoing development work**, where the agent revisits the same API repeatedly without you re-pasting documentation.

Install in your MCP client (stdio transport; the client spawns the process):

```bash
# OpenCode
opencode mcp add swagger-digest -- npx -y swagger-digest-mcp
```

```json
// JSON-configured clients (Claude Desktop, Cursor, …)
{
  "mcpServers": {
    "swagger-digest": {
      "command": ["npx", "-y", "swagger-digest-mcp"]
    }
  }
}
```

Tool arguments and environment variables are documented in [MCP configuration](#mcp-configuration).

### Option 2: Markdown digest

Generate a compact Markdown reference from any Swagger UI page or OpenAPI/Swagger spec — for documentation, sharing, or feeding API context into agents that don't use MCP.

```bash
# Interactive
npx swagger-digest

# Direct: fetch, digest, save
npx swagger-digest --url https://petstore.swagger.io/ --out-dir ./docs

# To stdout (pipes stay clean; progress goes to stderr)
npx swagger-digest --url https://petstore.swagger.io/ --stdout | pbcopy

# Keep only the operations you need
npx swagger-digest --url https://api.example.com/openapi.json \
  --include-tag Subscriptions --path-prefix /v1/ --out-dir ./docs
```

Output is a structured Markdown document: endpoint index, per-tag operation details (auth, parameters, request/response bodies, examples), and TypeScript-like data type declarations. Save it next to your code, paste it into a PR, or drop it into your agent's context manually.

## Quick start

```bash
# 1. Generate a digest from a public API (interactive prompts, saved to ~/Downloads)
npx swagger-digest --url https://petstore.swagger.io/

# 2. Or generate to stdout
npx swagger-digest --url https://petstore.swagger.io/ --stdout > petstore-digest.md

# 3. Register the MCP server (OpenCode example)
opencode mcp add swagger-digest -- npx -y swagger-digest-mcp
```

Requires Node.js 20+. Run `npx swagger-digest --help` for all options.

## Real-world example: building a subscriptions page

A React/TypeScript developer asks their AI coding agent:

> "Implement a subscription management page against our billing API — docs are at https://api.example.com/swagger-ui"

**Without swagger-digest**, the agent either guesses the API contract or you paste thousands of lines of raw JSON into the conversation.

**With the MCP server**, the agent calls the tool itself:

```json
{
  "url": "https://api.example.com/swagger-ui",
  "include_tags": ["Subscriptions"]
}
```

and receives only the relevant slice — in this illustrative excerpt of digest output:

```markdown
#### `GET /v1/subscriptions/{id}`

**Authentication:** Bearer

**Parameters**

- `id` (`path`, required) · `string` — Subscription identifier.
- `expand` (`query`, optional) · `string[]` — Fields to expand.

**Responses**

- **200 OK** — `Subscription` (application/json)

## Data types

export interface Subscription {
id?: string;
status?: "active" | "canceled" | "past_due";
current_period_end?: number;
items?: SubscriptionItems;
[key: string]: unknown;
}
```

From there the agent can: confirm the exact path, method and required parameters; read the `Subscription` schema and its referenced types; generate TypeScript types that match the contract; and implement the page without guessing. If the digest is too large, the agent re-calls with `path_prefix` or `max_tokens` to narrow it further.

## Benchmarks

Ten public APIs, digest vs. raw spec JSON in an LLM context, ground truth from the parsed raw specs. Run in November 2026 against swagger-digest 0.2.0; token counts are heuristic estimates, not tokenizer-exact.

**7/10 wins · 100% operation coverage on every digest produced · 1.6–3.7× lighter · 1 tool call vs 1–5 fetch/guess attempts**

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

**Why token efficiency matters:** an agent's context window is shared between your codebase, the conversation, and every tool result. A raw spec that consumes 500k tokens crowds out everything else; the same API as a 150k-token digest leaves room to work — and smaller digests mean faster, cheaper, more focused generations.

\* Raw's three "wins" carry heavy caveats: the Petstore UI-page case needed brute-forced candidate URLs (the digest's discovery has since been fixed for that class of pages); GitHub's 3.55M-token raw spec would truncate in any model's context anyway; and the Kubernetes expansion is now prevented by the default token cap described below.

### Known failure modes (and their mitigations)

| Case                                                         | What happens                                                           | Mitigation                                                                                                                             |
| ------------------------------------------------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| JS-only Swagger UI pages with dynamically computed spec URLs | Literal extraction finds nothing after `url:`                          | **Fixed in 0.3.0** (embedded spec-URL scan). Otherwise pass `spec_url` / `--spec` explicitly                                           |
| Mega-specs (Kubernetes-class, ≥1M tokens)                    | Digest can _expand_ past raw size — descriptions inlined per operation | **Default in 0.3.0**: automatic 250k-token cap (opt out with `--no-auto-trim` / `auto_trim: false`). Explicit `max_tokens` always wins |
| Huge fetches (14 MB GitHub spec)                             | Fetch fails at the 10 MB response cap                                  | Use a filtered direct spec URL                                                                                                         |

Not every specification benefits: very large kitchen-sink specs are where compression can invert — handled by the default cap, but worth knowing.

## Feature overview

**Ingestion and discovery**

- Fetches direct OpenAPI JSON/YAML URLs and Swagger UI pages (OpenAPI 2.0, 3.0, 3.1).
- Multi-strategy discovery: direct spec URL → page script configuration (`url:`, `urls:` dropdown, inline `spec:`, dynamically computed initializer URLs) → common spec paths (`/v3/api-docs`, `/swagger.json`, …) → optional headless-browser fallback.
- Multi-spec Swagger UI dropdowns: probes candidates in order, uses the first that parses, names the pick.
- External `$ref` bundling: references to other HTTP(S) documents are fetched and inlined under namespaced names (one level deep, at most 5 documents).

**Markdown generation**

- Endpoint index plus per-tag operation details: auth requirements, path/query/header parameters, request bodies, success/error responses, examples.
- TypeScript-like type declarations for reachable schemas; `allOf`/`oneOf`/`anyOf`, enums, arrays, nullable fields, `additionalProperties` get compact representations.
- Unknown schema constructs render as `unknown` instead of failing the digest.
- Synthetic examples generated from schemas when none are declared, clearly marked as illustrative.

**MCP server**

- Single `swagger_digest` tool over stdio; digest returned inline in the tool result with metadata (retrieval method, operation/model counts, token estimate), or written to a file.
- Same discovery and filtering pipeline as the CLI; optional Playwright fallback disabled.
- Private-network (SSRF) guard on by default, because URLs come from the model.

**Filtering and token management**

- Filter by tags (`include_tags`/`exclude_tags`) and path prefix, before rendering.
- `max_tokens` budget with deterministic trim order; `## Trimmed` note records exactly what was removed.
- Automatic 250,000-token default cap for unbounded digests.

**Authentication and remote access**

- Origin-scoped custom headers and cookies: sent only to the origin you supply, never logged, never written to the digest.
- `SWAGGER_DIGEST_HEADER` environment variable for secrets outside the command line.
- Hardened fetching: response size cap (10 MB), redirect limit (5), timeouts, optional private-network blocking.

## Configuration and advanced usage

### CLI reference

| Option                         | Description                                               |
| ------------------------------ | --------------------------------------------------------- |
| `-u, --url <url>`              | Swagger UI page URL or direct OpenAPI spec URL            |
| `-d, --out-dir <directory>`    | Destination directory for the digest file                 |
| `-f, --filename <filename>`    | Output filename (defaults to `<api-title>-digest.md`)     |
| `--stdout`                     | Print to stdout instead of writing a file                 |
| `--spec <url>`                 | Explicit spec URL; overrides all discovery                |
| `--include-tag <tag>`          | Keep only operations with this tag (repeatable)           |
| `--exclude-tag <tag>`          | Drop operations with this tag (repeatable)                |
| `--path-prefix <prefix>`       | Keep only operations whose path starts with this prefix   |
| `--max-tokens <n>`             | Trim the digest until the token estimate fits this budget |
| `--no-auto-trim`               | Disable the automatic 250,000-token default cap           |
| `--max-bytes <bytes>`          | Maximum response size (default 10,000,000)                |
| `-H, --header <"Name: value">` | Custom request header, repeatable; origin-scoped          |
| `--cookie <string>`            | Convenience for a Cookie header; origin-scoped            |
| `--no-browser`                 | Disable the optional Playwright fallback                  |

### MCP configuration

Register the server (stdio transport):

```bash
# OpenCode
opencode mcp add swagger-digest -- npx -y swagger-digest-mcp
```

```json
// JSON-configured clients
{
  "mcpServers": {
    "swagger-digest": {
      "command": ["npx", "-y", "swagger-digest-mcp"]
    }
  }
}
```

The `swagger_digest` tool:

| Argument        | Type             | Description                                                  |
| --------------- | ---------------- | ------------------------------------------------------------ |
| `url`           | string, required | Swagger UI page URL or direct OpenAPI spec URL               |
| `spec_url`      | string           | Explicit spec URL; overrides discovery                       |
| `headers`       | object           | Request headers; sent only to the origin of `url`            |
| `include_tags`  | string[]         | Keep only operations with these tags                         |
| `exclude_tags`  | string[]         | Drop operations with these tags                              |
| `path_prefix`   | string           | Keep only paths starting with this prefix                    |
| `max_tokens`    | number           | Trim the digest to an approximate token budget               |
| `auto_trim`     | boolean          | Default-cap digests without `max_tokens` (default true)      |
| `write_to_file` | object           | `{ directory, filename }` — save instead of returning inline |

MCP environment variables:

- `SWAGGER_DIGEST_HEADER` — newline-separated `Name: value` pairs, merged with (and overridden by) the call's `headers`. Keeps secrets out of the conversation.
- `SWAGGER_DIGEST_ALLOW_PRIVATE=1` — opt out of the private-network guard; only for hosts you trust, e.g. internal corporate APIs.

MCP-specific behavior: URLs resolving to loopback/private/link-local addresses are rejected by default (MCP clients supply URLs on the model's behalf); diagnostics go to stderr, protocol frames to stdout.

### Authentication headers (CLI)

```bash
npx swagger-digest --url https://api.example.com/swagger-ui \
  --header "Authorization: Bearer eyJhbGciOi..." --out-dir ./docs

# or a session cookie
npx swagger-digest --url https://api.example.com/swagger-ui --cookie "session=abc123"

# or the environment variable (-H flags win on conflicts)
export SWAGGER_DIGEST_HEADER=$'Authorization: Bearer eyJ…\nX-Tenant: acme'
npx swagger-digest --url https://api.example.com/swagger-ui
```

**Scoping and safety:** custom headers are sent **only** to the origin of the URL you supply; cross-origin requests (redirects, discovered specs on other origins) proceed without them and produce a warning naming the other origin. In the headless-browser fallback, headers are injected per-request for your origin only — they never reach CDNs or third-party scripts. Header values are never logged, written to the digest, or included in error messages. Secrets passed with `-H` can end up in shell history — prefer the environment variable.

### Programmatic API

```ts
import { fetchOpenApiSpec, transformOpenApiToMarkdown, estimateTokens } from 'swagger-digest';

const { spec, sourceUrl } = await fetchOpenApiSpec('https://api.example.com/openapi.json', {
  blockPrivateNetworks: true, // recommended when URLs come from untrusted input
  headers: { Authorization: 'Bearer …' },
});
const markdown = transformOpenApiToMarkdown(spec, sourceUrl, {
  includeTags: ['Subscriptions'],
  maxTokens: 50_000,
  onWarning: console.warn,
});
console.log(estimateTokens(markdown).models.claude.tokens);
```

`transformOpenApiToMarkdown` options: `includeTags`, `excludeTags`, `pathPrefix`, `maxTokens`, `autoTrim` (default true), `onWarning`. `fetchOpenApiSpec` options include `specUrl`, `headers`, `maxBytes`, `blockPrivateNetworks`, `useBrowserFallback`.

### Trimming order

When a budget applies (explicit `--max_tokens` or the default cap), the digest is trimmed in this fixed order, re-checked after each step: 1) drop declared example payloads → 2) shorten long descriptions → 3) collapse parameter/response detail per tag (the tag appearing last in the document is collapsed first) → 4) keep only the Quick index. A `## Trimmed` note records exactly which steps applied; schemas referenced only by removed operations are dropped. The estimator is a heuristic — treat budgets as a guide, not a guarantee.

## Supported specifications and limitations

**Supported:** OpenAPI 2.0, 3.0 and 3.1, in JSON or YAML, fetched over HTTP(S) from direct spec URLs or discovered through Swagger UI pages.

**Limitations:**

- The tool downloads specs exposed by the supplied server. It does not bypass authentication, browser access controls, or network restrictions. Ordinary HTTP fetches use Node.js networking — they do not reuse a browser's VPN extension, cookies, or signed-in session. If a page works in Chrome but not here, test `curl -v -L '<url>'` from the terminal; if that fails too, route the terminal through your VPN/proxy.
- External `$ref` documents are bundled best-effort (one level deep, at most 5 documents); unreachable references degrade to named type references and the digest still succeeds.
- Very large specs: fetches are capped at 10 MB by default (`--max-bytes`), and digests are capped at ~250k estimated tokens by default (see trimming above).
- A generated digest is a compact developer reference, not a replacement for the source OpenAPI contract.

**Security notes:** the tool fetches the URL you supply, same-origin Swagger UI initializer/config scripts, the spec URL referenced by that page, and a short list of common spec paths on the same origin. Cookies and Authorization headers are never sent automatically. If you call `fetchOpenApiSpec` from a server that accepts user-supplied URLs, enable `blockPrivateNetworks: true` — without it a caller can point the tool at cloud-metadata or other internal addresses (SSRF); the check rejects loopback, link-local, private, and unique-local addresses after redirects, but has a documented DNS-rebinding limitation — for hostile multi-tenant input, use a dedicated egress proxy. The MCP server enables this guard by default.

## Development and contribution

```bash
npm install
npm run build
npm test        # typecheck + test suite (runs offline against fixtures)
npm run lint
npm link        # then: swagger-digest / swagger-digest-mcp
```

Manual check against a live API:

```bash
npm run build
node dist/cli.js --url https://petstore.swagger.io/ --out-dir ./tmp --filename petstore-digest.md
```

Project layout:

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

## License

MIT
