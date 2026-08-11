import { spawn } from "node:child_process";
import path from "node:path";

const npmCliPath = process.env.npm_execpath;
if (!npmCliPath || !path.isAbsolute(npmCliPath)) {
  throw new Error("Development startup requires npm run dev so npm_execpath is available");
}

const children = [
  spawn(process.execPath, ["--watch", "server/index.mjs", "--dev"], {
    stdio: "inherit",
  }),
  spawn(process.execPath, [npmCliPath, "run", "dev:web"], {
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  }),
];

let shuttingDown = false;

function stop(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = exitCode;
}

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (!shuttingDown && code !== 0 && signal !== "SIGTERM") stop(code ?? 1);
  });
}

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
