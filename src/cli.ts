#!/usr/bin/env node

import { input } from '@inquirer/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import ora from 'ora';
import { fetchOpenApiSpec } from './fetcher.js';
import { transformOpenApiToMarkdown } from './transformer.js';
import { estimateTokens } from './tokens.js';
import { VERSION } from './version.js';
import { mergeHeaders, parseHeaderArgument, parseHeaderPairs } from './headers.js';
import { defaultFilename, defaultOutputDirectory, writeDigest } from './writer.js';

interface CliOptions {
  url?: string;
  outDir?: string;
  filename?: string;
  browser?: boolean;
  maxBytes?: string;
  headers?: string[];
  cookie?: string;
  includeTag?: string[];
  excludeTag?: string[];
  pathPrefix?: string;
  maxTokens?: string;
  stdout?: boolean;
  spec?: string;
}

function validateUrl(value: string): true | string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Use an http:// or https:// URL.';
    return true;
  } catch {
    return 'Enter a valid URL, including https://.';
  }
}

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function parseMaxBytes(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    throw new Error(`Invalid --max-bytes value: ${value}. Use a positive integer number of bytes.`);
  }
  return parsed;
}

function parseMaxTokens(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    throw new Error(`Invalid --max-tokens value: ${value}. Use a positive integer number of tokens.`);
  }
  return parsed;
}

function collectOption(value: string, previous: string[]): string[] {
  return [...(previous ?? []), value];
}

function buildRequestHeaders(options: CliOptions): Record<string, string> {
  // Environment headers first, then -H flags (flags win on conflict), then --cookie.
  const fromEnv = process.env.SWAGGER_DIGEST_HEADER ? parseHeaderPairs(process.env.SWAGGER_DIGEST_HEADER) : {};
  const fromFlags = (options.headers ?? []).map(parseHeaderArgument);
  const cookieHeader = options.cookie !== undefined ? parseHeaderArgument(`Cookie: ${options.cookie}`) : {};
  return mergeHeaders(fromEnv, ...fromFlags, cookieHeader);
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('swagger-digest')
    .description('Convert a Swagger UI page or OpenAPI URL into compact, AI-friendly Markdown.')
    .version(VERSION)
    .option('-u, --url <url>', 'Swagger UI page URL or direct OpenAPI spec URL')
    .option('-d, --out-dir <directory>', 'Directory where the Markdown digest will be saved')
    .option('-f, --filename <filename>', 'Output filename (defaults to <api-title>-digest.md)')
    .option('--no-browser', 'Disable the optional Playwright headless-browser fallback')
    .option('--max-bytes <bytes>', 'Maximum response size in bytes (default 10000000 = 10 MB)', '10000000')
    .option(
      '-H, --header <"Name: value">',
      'Custom request header, repeatable. Sent only to the URL you supplied.',
      collectOption,
      [],
    )
    .option('--cookie <string>', 'Convenience for a Cookie request header (same-origin scoping applies)')
    .option('--include-tag <tag>', 'Keep only operations with this tag, repeatable', collectOption, [])
    .option('--exclude-tag <tag>', 'Drop operations with this tag, repeatable', collectOption, [])
    .option('--path-prefix <prefix>', 'Keep only operations whose path starts with this prefix')
    .option('--max-tokens <n>', 'Trim the digest until the approximate token estimate fits this budget')
    .option('--spec <url>', 'Explicit OpenAPI spec URL; overrides discovery from the Swagger UI page')
    .option('--stdout', 'Print the digest to standard output instead of writing a file')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  npx swagger-digest',
        '  npx swagger-digest --url https://petstore.swagger.io/ --out-dir ./docs',
        '  npx swagger-digest -u https://example.com/openapi.yaml -f payments-api.md',
        '  npx swagger-digest -u https://api.example.com/swagger-ui -H "Authorization: Bearer <token>"',
        '',
        'Authentication:',
        '  -H/--header and --cookie values are sent ONLY to the origin of --url.',
        '  You can also set SWAGGER_DIGEST_HEADER with newline-separated "Name: value" pairs;',
        '  -H flags override it on conflicts. Avoid passing secrets on the command line if',
        '  your shell saves history — prefer the environment variable.',
        '',
        'Filtering and token budget:',
        '  --include-tag/--exclude-tag/--path-prefix remove operations (and the data',
        '  models only they referenced) before rendering.',
        '  --max-tokens trims the digest in this order until the estimate fits:',
        '  1. drop declared example payloads → 2. shorten descriptions →',
        '  3. collapse parameter/response detail per tag (lowest-priority tag first:',
        '  the tag that appears last in the document is collapsed first) →',
        '  4. keep only the Quick index entries. A "Trimmed" note records what was',
        '  removed. The estimator is a heuristic, NOT tokenizer-accurate — treat the',
        '  budget as a guide, not a guarantee.',
      ].join('\n'),
    );

  program.parse(process.argv);
  const options = program.opts<CliOptions>();

  if (!options.url && !isInteractive()) {
    throw new Error('An interactive terminal or --url is required. Run `swagger-digest --help` for usage.');
  }

  const url =
    options.url ??
    (await input({
      message: 'Swagger UI or OpenAPI spec URL',
      validate: validateUrl,
    }));
  const validUrl = validateUrl(url);
  if (validUrl !== true) throw new Error(validUrl);

  if (options.stdout && (options.outDir !== undefined || options.filename !== undefined)) {
    throw new Error(
      '--stdout cannot be combined with --out-dir or --filename: it prints the digest to standard output instead of writing a file. Drop --stdout, or remove --out-dir/--filename.',
    );
  }

  const outputDirectory =
    options.outDir ??
    (isInteractive() && !options.stdout
      ? await input({
          message: 'Destination directory',
          default: defaultOutputDirectory(),
          validate: (value) => (value.trim() ? true : 'Enter a destination directory.'),
        })
      : defaultOutputDirectory());

  const maxBytes = parseMaxBytes(options.maxBytes);
  const requestHeaders = buildRequestHeaders(options);
  const spinner = ora({ text: 'Fetching and parsing OpenAPI definition…', color: 'cyan' }).start();
  let result;
  try {
    result = await fetchOpenApiSpec(url, {
      useBrowserFallback: options.browser !== false,
      maxBytes,
      headers: requestHeaders,
      specUrl: options.spec,
      warn: (message) => console.error(chalk.yellow(`Warning: ${message}`)),
    });
  } catch (error) {
    spinner.fail('Could not extract an OpenAPI definition');
    throw error;
  }

  const title = typeof result.spec.info?.title === 'string' ? result.spec.info.title : 'API';
  const markdown = transformOpenApiToMarkdown(result.spec, result.sourceUrl, {
    includeTags: options.includeTag,
    excludeTags: options.excludeTag,
    pathPrefix: options.pathPrefix,
    maxTokens: parseMaxTokens(options.maxTokens),
    onWarning: (message) => console.error(chalk.yellow(`Warning: ${message}`)),
  });
  spinner.succeed(`Parsed ${title} (${result.retrievalMethod})`);

  if (options.stdout) {
    // Exactly one artifact on stdout; progress, warnings and the token report
    // already go to stderr (ora defaults to stderr), so pipes stay clean.
    process.stdout.write(markdown);
    return;
  }

  const filename =
    options.filename ??
    (isInteractive()
      ? await input({
          message: 'Output filename',
          default: defaultFilename(title),
          validate: (value) => (value.trim() ? true : 'Enter a filename.'),
        })
      : defaultFilename(title));

  const writeSpinner = ora({ text: 'Writing Markdown digest…', color: 'cyan' }).start();
  try {
    const outputPath = await writeDigest({ markdown, directory: outputDirectory, filename });
    writeSpinner.succeed(`Saved ${chalk.green(outputPath)}`);

    const report = estimateTokens(markdown);
    const endpointCount = Object.values(result.spec.paths ?? {}).reduce((count: number, pathItem: unknown) => {
      if (!pathItem || typeof pathItem !== 'object') return count;
      const methods = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
      const operations = pathItem as Record<string, unknown>;
      return count + methods.filter((method) => operations[method] && typeof operations[method] === 'object').length;
    }, 0);
    const modelCount = Object.keys((result.spec.components?.schemas ?? result.spec.definitions ?? {}) as object).length;

    console.log('');
    console.log(chalk.bold('Digest summary:'));
    console.log(`  ${chalk.dim('•')} Endpoints:       ${chalk.cyan(endpointCount)} operations`);
    if (modelCount > 0) {
      console.log(`  ${chalk.dim('•')} Data models:     ${chalk.cyan(modelCount)} schemas`);
    }
    console.log(`  ${chalk.dim('•')} Characters:      ${chalk.dim(report.characters.toLocaleString())}`);
    console.log('');
    console.log(chalk.bold('Estimated token usage (approximate):'));

    for (const model of Object.values(report.models)) {
      const windowLabel =
        model.contextWindow >= 1_000_000 ? `${model.contextWindow / 1_000_000}M` : `${model.contextWindow / 1_000}k`;

      const paddedName = `${model.name}:`.padEnd(30, ' ');
      const tokenStr = `~${model.tokens.toLocaleString()} tokens`.padEnd(16, ' ');
      const percentStr = chalk.dim(`(${model.contextPercent}% of ${windowLabel} context)`);

      console.log(`  ${chalk.dim('•')} ${paddedName} ${chalk.green(tokenStr)} ${percentStr}`);
    }
    console.log('');
  } catch (error) {
    writeSpinner.fail('Could not write digest');
    throw error;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(chalk.red(`\nError: ${message}`));
  process.exitCode = 1;
});
