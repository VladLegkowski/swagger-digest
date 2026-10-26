import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateTokens, type DigestTokenReport } from '../src/tokens.js';

test('empty input estimates zero tokens for every model', () => {
  const report = estimateTokens('');
  assert.equal(report.characters, 0);
  for (const model of Object.values(report.models)) {
    assert.equal(model.tokens, 0);
    assert.equal(model.contextPercent, 0);
  }
});

test('estimates grow monotonically with input length', () => {
  const totalTokens = (report: DigestTokenReport): number =>
    Object.values(report.models).reduce((sum, model) => sum + model.tokens, 0);

  const short = estimateTokens('# Small\n\nA few words.');
  const medium = estimateTokens('# Medium\n\nsome words here '.repeat(50));
  const large = estimateTokens('# Large\n\nsome words here '.repeat(500));

  assert.ok(totalTokens(short) < totalTokens(medium), 'estimate grows from short to medium input');
  assert.ok(totalTokens(medium) < totalTokens(large), 'estimate grows with input length');
});

test('contextPercent is consistent with tokens and the context window', () => {
  const sampleMarkdown =
    '# Petstore API\n\n| Method | Path |\n|---|---|\n| GET | /pets |\n\n```typescript\ninterface Pet { id: number; name: string; }\n```';
  const report = estimateTokens(sampleMarkdown);

  assert.ok(report.characters > 0);
  for (const model of Object.values(report.models)) {
    const expected = Number(((model.tokens / model.contextWindow) * 100).toFixed(1));
    assert.equal(model.contextPercent, expected);
    assert.ok(model.contextWindow > 0);
    assert.ok(model.tokens >= 0);
    assert.ok(model.name.length > 0);
  }
});
