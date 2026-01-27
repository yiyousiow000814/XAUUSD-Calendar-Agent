import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(process.cwd());
const versionFile = "app/agent/version.txt";

const readText = async (relPath) => fs.readFile(path.join(repoRoot, relPath), "utf8");
const writeText = async (relPath, text) => {
  const abs = path.join(repoRoot, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const normalized = text.endsWith("\n") ? text : `${text}\n`;
  await fs.writeFile(abs, normalized, "utf8");
};

const readVersion = async () => {
  const text = await readText(versionFile);
  const version = text.trim();
  if (!version) throw new Error(`Empty version file: ${versionFile}`);
  return version;
};

const setVersion = async (version) => {
  const next = `${version}\n`;
  await writeText(versionFile, next);
};

const updateJsonVersion = async (relPath, version) => {
  const abs = path.join(repoRoot, relPath);
  const data = JSON.parse(await fs.readFile(abs, "utf8"));
  data.version = version;
  await writeText(relPath, JSON.stringify(data, null, 2));
};

const updateTauriConfVersion = async (version) => {
  await updateJsonVersion("app/tauri/src-tauri/tauri.conf.json", version);
};

const updateCargoTomlVersion = async (version) => {
  const relPath = "app/tauri/src-tauri/Cargo.toml";
  const text = await readText(relPath);
  const lines = text.split(/\r?\n/);

  let inPackage = false;
  let patched = false;
  const out = lines.map((line) => {
    const header = line.match(/^\s*\[(.+?)\]\s*$/);
    if (header) {
      inPackage = header[1].trim() === "package";
    }
    if (!patched && inPackage) {
      const m = line.match(/^\s*version\s*=\s*"([^"]+)"\s*$/);
      if (m) {
        patched = true;
        return `version = "${version}"`;
      }
    }
    return line;
  });

  if (!patched) {
    throw new Error(`Failed to patch version in ${relPath} ([package] version = "...")`);
  }
  await writeText(relPath, out.join("\n"));
};

const main = async () => {
  const args = process.argv.slice(2);
  const setIdx = args.findIndex((v) => v === "--set");
  if (setIdx !== -1) {
    const version = String(args[setIdx + 1] || "").trim();
    if (!version) throw new Error("Missing value for --set <version>");
    await setVersion(version);
  }

  const version = await readVersion();

  await updateJsonVersion("app/webui/package.json", version);
  await updateJsonVersion("app/tauri/package.json", version);
  await updateCargoTomlVersion(version);
  await updateTauriConfVersion(version);

  process.stdout.write(`synced version=${version}\n`);
};

await main();
