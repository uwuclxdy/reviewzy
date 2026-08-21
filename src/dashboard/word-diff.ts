/**
 * The word-level diff between the anchor text and the proposed text, computed server-side at
 * render time so the marks need no client js. Whitespace-token based: the split keeps whitespace
 * runs as their own tokens, so both streams re-join to their exact input, bytes included.
 */

/** One token of a diffed string, carrying its mark. Whitespace runs are tokens too, always `same` when both sides share them. */
export type WordDiffToken = {
  readonly text: string;
  readonly kind: "same" | "removed" | "added";
};

export type WordDiff = {
  /** The anchor text tokenized: tokens the proposal does not keep are `removed`, the rest `same`. */
  readonly before: readonly WordDiffToken[];
  /** The proposal tokenized: tokens the anchor did not have are `added`, the rest `same`. */
  readonly after: readonly WordDiffToken[];
};

/** Splits on whitespace boundaries, keeping the runs: `"a b"` becomes `["a", " ", "b"]`. */
function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter((token) => token !== "");
}

/**
 * The LCS table is quadratic in token count, and the anchor is agent-controlled with no length
 * cap, so past this cell ceiling the walk is skipped: each side reads fully changed, which is
 * honest (no word is claimed unchanged) and renders in linear time.
 */
const MAX_LCS_CELLS = 1_000_000;

/**
 * A longest-common-subsequence walk over the two token streams: a token both sides share is
 * `same`, one only the anchor has is `removed`, one only the proposal has is `added`. Identical
 * strings produce all-`same` streams, so nothing renders a mark.
 */
export function diffWords(before: string, after: string): WordDiff {
  const a = tokenize(before);
  const b = tokenize(after);

  if (a.length * b.length > MAX_LCS_CELLS) {
    return {
      before: a.map((text) => ({ text, kind: "removed" as const })),
      after: b.map((text) => ({ text, kind: "added" as const })),
    };
  }

  // dp[i][j] is the LCS length of a[i:] against b[j:], filled bottom-up so the walk can pick the
  // branch that keeps the longest match. One flat typed array: 8 bytes a cell, no nested rows.
  const stride = b.length + 1;
  const dp = new Float64Array((a.length + 1) * stride);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const below = dp[(i + 1) * stride + j]!;
      const right = dp[i * stride + j + 1]!;
      dp[i * stride + j] = a[i] === b[j] ? below + 1 : Math.max(below, right);
    }
  }

  const beforeTokens: WordDiffToken[] = [];
  const afterTokens: WordDiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      beforeTokens.push({ text: a[i]!, kind: "same" });
      afterTokens.push({ text: b[j]!, kind: "same" });
      i++;
      j++;
    } else if (dp[(i + 1) * stride + j]! >= dp[i * stride + j + 1]!) {
      // Skipping the anchor's token keeps at least as long a match: it is removed.
      beforeTokens.push({ text: a[i]!, kind: "removed" });
      i++;
    } else {
      afterTokens.push({ text: b[j]!, kind: "added" });
      j++;
    }
  }
  while (i < a.length) {
    beforeTokens.push({ text: a[i]!, kind: "removed" });
    i++;
  }
  while (j < b.length) {
    afterTokens.push({ text: b[j]!, kind: "added" });
    j++;
  }

  return { before: beforeTokens, after: afterTokens };
}
