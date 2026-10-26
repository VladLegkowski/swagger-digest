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

Run `npx swagger-digest --help` for all CLI options. The package requires Node.js 20 or newer.

## What it extracts

The retrieval strategy deliberately avoids scraping rendered operation accordions or simulating UI clicks:

1. Fetch and parse a direct `.json`, `.yaml`, or `.yml` URL.
2. Fetch the Swagger UI page and inspect script configuration for `url: "..."` or an inline `spec: { ... }` object.
3. Try common spec endpoints on the same origin: `/v3/api-docs`, `/swagger/v1/swagger.json`, `/swagger.json`, `/openapi.json`, and `/api-docs`.
4. Optionally launch a headless Chromium browser and read the parsed specification from Swagger UI's in-memory state.

The first three paths use ordinary HTTP requests. The browser fallback is optional so the normal install stays lightweight. To enable it for a difficult JavaScript-initialized Swagger UI deployment:

```bash
npm install playwright
npx playwright install chromium
```

Then run the CLI again. Use `--no-browser` to disable the fallback.

### Troubleshooting access through a VPN

The ordinary HTTP fetches use Node.js networking; they do not automatically reuse a browser's VPN extension, cookies, or signed-in session. If the Swagger page works in Chrome but not in the CLI, first test the same URL from the terminal:

```bash
curl -v -L 'https://your-host.example/path/to/swagger-ui' -o /tmp/swagger-page.html
```

If `curl` cannot connect or receives `401`/`403`, connect a system-level VPN that also routes terminal applications, or configure the relevant corporate proxy/authentication for the terminal. Installing Playwright alone does not make a browser-only VPN extension available to its separate Chromium instance. If terminal access succeeds, the extractor now also reads same-origin Swagger UI initializer/config scripts and tries spec paths relative to the supplied page's context path.

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
```

## Limitations

- The tool downloads specs exposed by the supplied server. It does not bypass authentication, browser access controls, or network restrictions.
- External schema references are retained as named type references where possible; the tool does not currently fetch and bundle arbitrary external documents.
- Declared request/response examples are preserved. When an example is absent but a schema exists, a representative JSON example is generated from that schema and clearly marked as illustrative rather than spec-authored. The transformer includes the primary success response and applicable common error responses to balance useful payload context against digest size.
- A generated digest is a compact developer reference, not a replacement for the source OpenAPI contract.

## License

MIT
