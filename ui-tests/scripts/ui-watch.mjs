import chokidar from "chokidar";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

let running = false;
let queued = false;

const runCheck = () =>
  new Promise((resolve, reject) => {
    const child = spawn("node", ["scripts/ui-check.mjs"], {
      cwd: path.join(repoRoot, "ui-tests"),
      shell: true,
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
  path.join(repoRoot, "ui-tests", "tests"),
  path.join(repoRoot, "ui-tests", "helpers")
];

const watcher = chokidar.watch(watchPaths, {
  ignored: /dist|node_modules|artifacts|playwright-report/,
  ignoreInitial: true
});

watcher.on("all", () => schedule());

console.log("ui-watch running. Waiting for changes...");
