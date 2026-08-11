import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [statePath] = process.argv.slice(2);
if (!statePath) process.exit(2);

const descendant = spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
], {
  stdio: "ignore",
});
writeFileSync(statePath, JSON.stringify({
  childPid: process.pid,
  descendantPid: descendant.pid,
}));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
