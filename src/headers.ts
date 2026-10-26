/**
 * Header parsing for the `--header`/`--cookie` CLI options and the
 * SWAGGER_DIGEST_HEADER environment variable.
 *
 * Security rules:
 * - Header names and values must not contain CR/LF (header injection).
 * - Error messages name the header but never its value.
 */

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function validateHeaderName(name: string): void {
  if (!name) throw new Error('Header name must not be empty. Expected "Name: value".');
  if (/[\r\n]/.test(name)) {
    throw new Error(`Invalid header name: header names must not contain CR/LF characters.`);
  }
  if (!HEADER_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid header name "${name}": use a valid HTTP header token (letters, digits and -_).`);
  }
}

function validateHeaderValue(name: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`Invalid value for header "${name}": values must not contain CR/LF.`);
  }
  if (/\0/.test(value)) {
    throw new Error(`Invalid value for header "${name}": values must not contain NUL bytes.`);
  }
}

/**
 * Parses a single `--header "Name: value"` argument. The value may itself
 * contain colons; only the first colon separates name and value.
 */
export function parseHeaderArgument(raw: string): Record<string, string> {
  const separator = raw.indexOf(':');
  if (separator === -1) {
    // Reject CR/LF-bearing input outright, without echoing the full raw value.
    if (/[\r\n]/.test(raw)) {
      throw new Error(`Invalid header: names and values must not contain CR/LF.`);
    }
    throw new Error(`Invalid header — expected "Name: value" format (for example "Authorization: Bearer <token>").`);
  }
  const name = raw.slice(0, separator).trim();
  const value = raw.slice(separator + 1).trim();
  validateHeaderName(name);
  validateHeaderValue(name, value);
  return { [name.toLowerCase()]: value };
}

/**
 * Parses newline-separated `Name: value` pairs (e.g. from the
 * SWAGGER_DIGEST_HEADER environment variable). Blank lines are ignored.
 */
export function parseHeaderPairs(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    Object.assign(result, parseHeaderArgument(line));
  }
  return result;
}

/** Later sources win on conflicting header names. */
export function mergeHeaders(...sources: Array<Record<string, string> | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const source of sources) {
    if (!source) continue;
    for (const [name, value] of Object.entries(source)) {
      if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
        throw new Error(`Invalid header "${name}": CR/LF is not allowed in header names or values.`);
      }
      result[name.toLowerCase()] = value;
    }
  }
  return result;
}
