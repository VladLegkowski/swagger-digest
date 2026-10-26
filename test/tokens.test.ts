import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateTokens } from '../src/tokens.js';

test('handles empty strings gracefully', () => {
  const report = estimateTokens('');
  assert.equal(report.characters, 0);
  assert.equal(report.models.claude.tokens, 0);
  assert.equal(report.models.openai.tokens, 0);
  assert.equal(report.models.gemini.tokens, 0);
});

test('estimates token counts and context percentages correctly for markdown content', () => {
  const sampleMarkdown =
    '# Petstore API\n\n| Method | Path |\n|---|---|\n| GET | /pets |\n\n```typescript\ninterface Pet { id: number; name: string; }\n```';
  const report = estimateTokens(sampleMarkdown);

  assert.ok(report.characters > 0);
  assert.ok(report.models.claude.tokens > 0);
  assert.ok(report.models.openai.tokens > 0);
  assert.ok(report.models.gemini.tokens > 0);
  assert.ok(report.models.deepseek.tokens > 0);
  assert.ok(report.models.llama.tokens > 0);
  // Gemini 256k tokenizer should yield fewer tokens than Claude BPE
  assert.ok(report.models.gemini.tokens <= report.models.claude.tokens);
  assert.ok(report.models.gemini.contextPercent < 1.0);
});
