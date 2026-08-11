import { spawn } from "node:child_process";

const grandchild = spawn(
  process.execPath,
  ["-e", "setInterval(() => {}, 1_000)"],
  { stdio: "ignore" },
);

process.stdout.write(`${JSON.stringify({ grandchildPid: grandchild.pid })}\n`);
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
