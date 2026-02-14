export function parseNumber(raw: unknown): number | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const lowered = text.toLowerCase();
  if (
    lowered === "--" ||
    lowered === "\u2014" ||
    lowered === "-" ||
    lowered === "tba" ||
    lowered === "n/a" ||
    lowered === "na" ||
    lowered === "null"
  ) {
    return null;
  }
  const cleaned = text.replace(/,/g, "").replace(/%/g, "").replace(/\s+/g, "");
  const m = cleaned.match(/^([+-]?\d+(?:\.\d+)?)([kmbt])?$/i);
  if (!m) return null;
  const base = Number(m[1]);
  if (!Number.isFinite(base)) return null;
  const suf = (m[2] || "").toLowerCase();
  if (suf === "k") return base * 1_000;
  if (suf === "m") return base * 1_000_000;
  if (suf === "b") return base * 1_000_000_000;
  if (suf === "t") return base * 1_000_000_000_000;
  return base;
}

export function median(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = (s.length - 1) / 2;
  const lo = s[Math.floor(mid)] ?? 0;
  const hi = s[Math.ceil(mid)] ?? 0;
  return (lo + hi) / 2;
}

export function labelZ(z: number, eqFactor: number): number {
  if (!Number.isFinite(z)) return 0;
  if (Math.abs(z) <= eqFactor) return 0;
  return z > 0 ? 1 : 2; // 0="=", 1=">", 2="<"
}

