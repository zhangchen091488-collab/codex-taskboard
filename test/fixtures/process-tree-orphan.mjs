import { spawn } from "node:child_process";

const descendant = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)"],
  { stdio: "ignore" },
);

process.stdout.write(`${JSON.stringify({ descendantPid: descendant.pid })}\n`, () => {
  process.exit(7);
});
