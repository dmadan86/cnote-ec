const keywordLine = /^(.*?)(?:\s*\[(exact|phrase|broad)\])?$/;
/** One keyword per line. "-word" is a negative keyword; a trailing [exact], [phrase] or [broad] sets the match type (default phrase). */
export function parseKeywords(raw: string): { text: string; matchType: "exact" | "phrase" | "broad"; negative: boolean }[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const negative = l.startsWith("-");
      const m = keywordLine.exec(negative ? l.slice(1).trim() : l)!;
      return { text: m[1]!.trim(), matchType: (m[2] ?? "phrase") as "exact" | "phrase" | "broad", negative };
    })
    .filter((k) => k.text.length >= 2);
}

