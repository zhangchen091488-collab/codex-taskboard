import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const testDirectory = path.join(projectRoot, "test");
const isolatedTestNames = new Set(["inject-fullheight-regression.test.mjs"]);
const testFiles = (await readdir(testDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
  .sort((left, right) => left.name.localeCompare(right.name));

if (testFiles.length === 0) {
  throw new Error("No top-level Node test files were discovered");
}

const concurrentTestFiles = testFiles
  .filter((entry) => !isolatedTestNames.has(entry.name))
  .map((entry) => path.join("test", entry.name));
const isolatedTestFiles = testFiles
  .filter((entry) => isolatedTestNames.has(entry.name))
  .map((entry) => path.join("test", entry.name));

if (isolatedTestFiles.length !== isolatedTestNames.size) {
  throw new Error("The isolated Node test list is incomplete");
}

function runNodeTests(files) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", ...files], {
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
}

let exitCode = await runNodeTests(concurrentTestFiles);
if (exitCode === 0) {
  exitCode = await runNodeTests(isolatedTestFiles);
}
process.exitCode = exitCode;
