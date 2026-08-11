import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const testDirectory = path.join(projectRoot, "test");
const testFiles = (await readdir(testDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
  .map((entry) => path.join("test", entry.name))
  .sort();

if (testFiles.length === 0) {
  throw new Error("No top-level Node test files were discovered");
}

const exitCode = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["--test", ...testFiles], {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
  });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) {
      console.error(`Node test runner exited through signal ${signal}`);
      resolve(1);
      return;
    }
    resolve(code ?? 1);
  });
});

process.exitCode = exitCode;
