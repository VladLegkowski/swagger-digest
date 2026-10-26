export interface TokenEstimates {
  gpt4: number;
  claude: number;
  characters: number;
}

/**
 * Estimates token counts for Markdown/code context.
 * GPT-4/GPT-4o averages ~3.9-4.0 chars per token for code/markdown structures.
 * Claude tokenizers average ~3.5-3.6 chars per token.
 */
export function estimateTokens(text: string): TokenEstimates {
  const characters = text.length;
  if (characters === 0) {
    return { gpt4: 0, claude: 0, characters: 0 };
  }

  // Refined heuristic: punctuation/brackets in markdown & TS increase token density
  const structuralSymbols = (text.match(/[{}[\]()<>=:;,."`|/-]/g) || []).length;
  const wordCount = (text.match(/\b\w+\b/g) || []).length;

  // Base token approximations combining word boundaries and structural symbols
  const estimatedGpt = Math.round(wordCount * 1.25 + structuralSymbols * 0.45);
  const estimatedClaude = Math.round(estimatedGpt * 1.08); // Claude tokenizers generally split code/subwords slightly finer

  return {
    gpt4: estimatedGpt,
    claude: estimatedClaude,
    characters,
  };
}
