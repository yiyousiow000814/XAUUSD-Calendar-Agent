import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd(), "ui-tests", "artifacts");
const current = resolve(root, "current");
const baseline = resolve(root, "baseline");
const diff = resolve(root, "diff");

if (!existsSync(current)) {
  console.error("No current artifacts found. Run ui:test first.");
  process.exit(1);
}

if (existsSync(baseline)) {
  rmSync(baseline, { recursive: true, force: true });
}
if (existsSync(diff)) {
  rmSync(diff, { recursive: true, force: true });
}

mkdirSync(baseline, { recursive: true });
cpSync(current, baseline, { recursive: true });

console.log("Baseline updated from ui-tests/artifacts/current.");
