const ACRONYM_REPLACEMENTS: Array<[RegExp, string]> = [
  // Normalize common country abbreviations when upstream data casing is inconsistent.
  // Keep the transform narrow to avoid touching non-country abbreviations like "s.a." / "n.s.a.".
  [/\bu\.s\./gi, "U.S."],
  [/\bu\.k\./gi, "U.K."],
  [/\bu\.a\.e\./gi, "U.A.E."],
  [/\be\.u\./gi, "E.U."]
];

export function normalizeAcronyms(text: string): string {
  let out = text;
  for (const [pattern, replacement] of ACRONYM_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

