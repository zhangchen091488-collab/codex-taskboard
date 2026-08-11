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
    const failingTests = new Set();
    let pendingOutput = "";
    const child = spawn(process.execPath, ["--test", ...files], {
      cwd: projectRoot,
      env: process.env,
      stdio: ["inherit", "pipe", "pipe"],
    });
    const inspectOutput = (chunk, flush = false) => {
      pendingOutput += chunk;
      const lines = pendingOutput.split(/\r?\n/);
      pendingOutput = flush ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        const failure = line.match(/^\s*not ok \d+ - (.+)$/);
        if (failure) failingTests.add(failure[1]);
      }
    };
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      inspectOutput(chunk.toString());
    });
    child.stderr.pipe(process.stderr);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      inspectOutput("", true);
      if (signal) {
        console.error(`Node test runner exited through signal ${signal}`);
        resolve(1);
        return;
      }
      if (code !== 0 && process.env.GITHUB_ACTIONS === "true") {
        const detail = failingTests.size > 0
          ? `Failing Node tests: ${[...failingTests].join(", ")}`
          : "The Node test process failed without a TAP test name";
        const escaped = detail
          .replaceAll("%", "%25")
          .replaceAll("\r", "%0D")
          .replaceAll("\n", "%0A");
        console.log(`::error file=scripts/run-tests.mjs,title=Node tests failed::${escaped}`);
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
