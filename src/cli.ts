#!/usr/bin/env node

import { input } from '@inquirer/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import ora from 'ora';
import { fetchOpenApiSpec } from './fetcher.js';
import { transformOpenApiToMarkdown } from './transformer.js';
import { defaultFilename, defaultOutputDirectory, writeDigest } from './writer.js';

interface CliOptions {
  url?: string;
  outDir?: string;
  filename?: string;
  browser?: boolean;
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

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('swagger-digest')
    .description('Convert a Swagger UI page or OpenAPI URL into compact, AI-friendly Markdown.')
    .version('0.1.1')
    .option('-u, --url <url>', 'Swagger UI page URL or direct OpenAPI spec URL')
    .option('-d, --out-dir <directory>', 'Directory where the Markdown digest will be saved')
    .option('-f, --filename <filename>', 'Output filename (defaults to <api-title>-digest.md)')
    .option('--no-browser', 'Disable the optional Playwright headless-browser fallback')
    .addHelpText(
      'after',
      '\nExamples:\n  npx swagger-digest\n  npx swagger-digest --url https://petstore.swagger.io/ --out-dir ./docs\n  npx swagger-digest -u https://example.com/openapi.yaml -f payments-api.md',
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

  const outputDirectory =
    options.outDir ??
    (isInteractive()
      ? await input({
          message: 'Destination directory',
          default: defaultOutputDirectory(),
          validate: (value) => (value.trim() ? true : 'Enter a destination directory.'),
        })
      : defaultOutputDirectory());

  const spinner = ora({ text: 'Fetching and parsing OpenAPI definition…', color: 'cyan' }).start();
  let result;
  try {
    result = await fetchOpenApiSpec(url, { useBrowserFallback: options.browser !== false });
  } catch (error) {
    spinner.fail('Could not extract an OpenAPI definition');
    throw error;
  }

  const title = typeof result.spec.info?.title === 'string' ? result.spec.info.title : 'API';
  const markdown = transformOpenApiToMarkdown(result.spec, result.sourceUrl);
  spinner.succeed(`Parsed ${title} (${result.retrievalMethod})`);

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
    const endpointCount = Object.values(result.spec.paths ?? {}).reduce((count: number, pathItem: any) => {
      if (!pathItem || typeof pathItem !== 'object') return count;
      const methods = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
      return count + methods.filter((method) => pathItem[method] && typeof pathItem[method] === 'object').length;
    }, 0);
    console.log(chalk.dim(`Included ${endpointCount} endpoint(s).`));
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
