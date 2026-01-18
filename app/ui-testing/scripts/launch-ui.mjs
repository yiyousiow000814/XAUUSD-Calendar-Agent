import { spawn } from "node:child_process";

const mode = process.env.UI_SERVER || "preview";
const port = process.env.UI_PORT || "4173";

const run = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: true, stdio: "inherit", ...options });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with ${code}`));
      }
    });
  });

const startServer = () => {
  const script = mode === "dev" ? "dev" : "preview";
  const args = [
    "--prefix",
    "../webui",
    "run",
    script,
    "--",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort"
  ];
  const server = spawn("npm", args, { shell: true, stdio: "inherit" });
  const cleanup = () => server.kill();
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
  server.on("exit", (code) => process.exit(code ?? 0));
};

const main = async () => {
  if (mode !== "dev") {
    await run("npm", ["--prefix", "../webui", "run", "build"]);
  }
  startServer();
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
