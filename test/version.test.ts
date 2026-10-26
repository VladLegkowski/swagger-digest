import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { VERSION, USER_AGENT, readPackageVersion } from '../src/version.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
  name: string;
};

test('CLI version is read from package.json, not hardcoded', () => {
  assert.equal(VERSION, pkg.version);
});

test('user-agent matches package.json version', () => {
  assert.equal(USER_AGENT, `swagger-digest/${pkg.version}`);
});

test('unreadable package.json degrades to "unknown"', () => {
  assert.equal(readPackageVersion('file:///definitely/not/a/real/path/module.js'), 'unknown');
});
