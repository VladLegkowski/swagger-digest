export interface ModelTokenEstimate {
  name: string;
  tokens: number;
  contextWindow: number;
  contextPercent: number;
}

export interface DigestTokenReport {
  characters: number;
  models: {
    claude: ModelTokenEstimate;
    openai: ModelTokenEstimate;
    gemini: ModelTokenEstimate;
    deepseek: ModelTokenEstimate;
    llama: ModelTokenEstimate;
  };
}

/**
 * Single source of truth for the model table shown in the digest summary.
 *
 * NOTE: these model names, context windows and ratios are a snapshot taken in
 * October 2026 and need periodic review as frontier models change. The ratios
 * are invented multipliers on one heuristic — they express a rough ordering
 * between tokenizer families, NOT measured tokenizer output.
 */
const MODEL_CONFIGS = {
  claude: { name: 'Claude (Sonnet / Opus)', contextWindow: 200_000, ratio: 1.08 },
  openai: { name: 'OpenAI (GPT-4o / o-series)', contextWindow: 128_000, ratio: 0.95 },
  gemini: { name: 'Google Gemini (Pro / Flash)', contextWindow: 1_000_000, ratio: 0.9 },
  deepseek: { name: 'DeepSeek (V3 / R1)', contextWindow: 128_000, ratio: 0.97 },
  llama: { name: 'Meta Llama (3.3 / 4)', contextWindow: 128_000, ratio: 0.98 },
} as const satisfies Record<string, { name: string; contextWindow: number; ratio: number }>;

/**
 * Produces ROUGH token-count estimates for Markdown/code. The numbers are a
 * heuristic (word + symbol density with per-model multipliers), not accurate
 * tokenizer counts — use them as an order-of-magnitude guide only.
 */
export function estimateTokens(text: string): DigestTokenReport {
  const characters = text.length;
  if (characters === 0) {
    const zeroModel = ({ name, contextWindow }: { name: string; contextWindow: number }): ModelTokenEstimate => ({
      name,
      tokens: 0,
      contextWindow,
      contextPercent: 0,
    });
    return {
      characters: 0,
      models: {
        claude: zeroModel(MODEL_CONFIGS.claude),
        openai: zeroModel(MODEL_CONFIGS.openai),
        gemini: zeroModel(MODEL_CONFIGS.gemini),
        deepseek: zeroModel(MODEL_CONFIGS.deepseek),
        llama: zeroModel(MODEL_CONFIGS.llama),
      },
    };
  }

  // Token density factors in technical markdown:
  // Words, markdown table pipes, TS braces, and structural syntax
  const wordCount = (text.match(/\b[\w$]+\b/gu) || []).length;
  const syntaxSymbols = (text.match(/[{}[\]()<>=:;,."`|/-]/g) || []).length;
  const whitespaces = (text.match(/\s+/g) || []).length;

  // Base BPE reference approximation (roughly cl100k standard)
  const baseTokens = wordCount * 1.18 + syntaxSymbols * 0.42 + whitespaces * 0.05;

  const calculate = (name: string, ratio: number, contextWindow: number): ModelTokenEstimate => {
    const tokens = Math.max(1, Math.round(baseTokens * ratio));
    const contextPercent = Number(((tokens / contextWindow) * 100).toFixed(1));
    return { name, tokens, contextWindow, contextPercent };
  };

  return {
    characters,
    models: {
      claude: calculate(MODEL_CONFIGS.claude.name, MODEL_CONFIGS.claude.ratio, MODEL_CONFIGS.claude.contextWindow),
      openai: calculate(MODEL_CONFIGS.openai.name, MODEL_CONFIGS.openai.ratio, MODEL_CONFIGS.openai.contextWindow),
      gemini: calculate(MODEL_CONFIGS.gemini.name, MODEL_CONFIGS.gemini.ratio, MODEL_CONFIGS.gemini.contextWindow),
      deepseek: calculate(
        MODEL_CONFIGS.deepseek.name,
        MODEL_CONFIGS.deepseek.ratio,
        MODEL_CONFIGS.deepseek.contextWindow,
      ),
      llama: calculate(MODEL_CONFIGS.llama.name, MODEL_CONFIGS.llama.ratio, MODEL_CONFIGS.llama.contextWindow),
    },
  };
}
