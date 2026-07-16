import chokidar from "chokidar";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");

let running = false;
let queued = false;

const checkArgs = () => {
  const mode = (process.env.UI_WATCH_MODE || "fast").trim().toLowerCase();
  if (mode === "full") return ["scripts/ui-check.mjs"];
  if (mode === "market-agent") {
    return ["scripts/ui-check.mjs", "--theme", "dark", "--filter", "Market Agent"];
  }
  return ["scripts/ui-check.mjs", "--theme", "dark", "--filter", "Market Agent dashboard smoke"];
};

const runCheck = () =>
  new Promise((resolve, reject) => {
    const args = checkArgs();
    console.log(`ui-watch running: node ${args.join(" ")}`);
    const child = spawn("node", args, {
      cwd: path.join(repoRoot, "app", "tests-ui"),
      shell: false,
      stdio: "inherit"
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ui-check exited ${code}`));
      }
    });
  });

const schedule = () => {
  if (running) {
    queued = true;
    return;
  }
  running = true;
  runCheck()
    .catch((err) => console.error(err))
    .finally(() => {
      running = false;
      if (queued) {
        queued = false;
        schedule();
      }
    });
};

const watchPaths = [
  path.join(repoRoot, "app", "webui", "src"),
  path.join(repoRoot, "app", "webui", "index.html"),
  path.join(repoRoot, "app", "tests-ui", "specs"),
  path.join(repoRoot, "app", "tests-ui", "helpers")
];

const watcher = chokidar.watch(watchPaths, {
  ignored: /dist|node_modules|artifacts|playwright-report/,
  ignoreInitial: true
});

watcher.on("all", () => schedule());

console.log("ui-watch running. Waiting for changes... Set UI_WATCH_MODE=full for full regression.");
