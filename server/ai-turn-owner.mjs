import { spawn } from "node:child_process";
import { Socket } from "node:net";

import {
  PROCESS_STOP_RESULT,
  forceStopManagedChildTree,
  forceStopOwnedUnixProcessGroup,
} from "../shared/process-tree.mjs";

const [executable, encodedArgs] = process.argv.slice(2);
if (!executable || !encodedArgs) process.exit(2);

const child = spawn(executable, JSON.parse(encodedArgs), {
  env: process.env,
  stdio: "inherit",
});

const control = new Socket({ fd: 3, readable: true, writable: false });
let terminating = false;
const terminateGroup = async () => {
  if (terminating) return;
  terminating = true;
  control.destroy();
  if (process.platform === "win32") {
    try {
      const result = await forceStopManagedChildTree(child, { timeoutMs: 1_000 });
      if (result === PROCESS_STOP_RESULT.TIMED_OUT) child.kill("SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
    process.exit(1);
  }
  try {
    forceStopOwnedUnixProcessGroup(process.pid);
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {}
    process.exit(1);
  }
};
control.once("end", () => void terminateGroup());
control.once("error", () => void terminateGroup());
control.resume();

child.once("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
child.once("exit", (code, signal) => {
  if (terminating) process.exit(1);
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
