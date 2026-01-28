import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const exists = async (p) => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

const rmrf = async (p) => {
  await fs.rm(p, { recursive: true, force: true });
};

const copyFile = async (src, dst) => {
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.copyFile(src, dst);
};

const copyDirRecursive = async (srcDir, dstDir) => {
  if (!(await exists(srcDir))) {
    throw new Error(`Missing source dir: ${srcDir}`);
  }
  await fs.mkdir(dstDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(src, dst);
    } else if (entry.isFile()) {
      await copyFile(src, dst);
    }
  }
};

const main = async () => {
  const srcData = path.join(repoRoot, "data");
  const srcCalendar = path.join(srcData, "Economic_Calendar");
  const srcHistory = path.join(srcData, "event_history_index");

  if (!(await exists(srcCalendar))) {
    throw new Error(`Missing source calendar data dir: ${srcCalendar}`);
  }
  if (!(await exists(srcHistory))) {
    throw new Error(`Missing source event history index dir: ${srcHistory}`);
  }

  const dstSeedRoot = path.join(
    repoRoot,
    "app",
    "tauri",
    "src-tauri",
    "resources",
    "seed-repo",
    "data",
  );

  await rmrf(path.join(repoRoot, "app", "tauri", "src-tauri", "resources", "seed-repo"));

  await copyDirRecursive(srcCalendar, path.join(dstSeedRoot, "Economic_Calendar"));
  await copyDirRecursive(srcHistory, path.join(dstSeedRoot, "event_history_index"));

  process.stdout.write("seed-repo: copied full data/Economic_Calendar and data/event_history_index\n");
};

await main();
