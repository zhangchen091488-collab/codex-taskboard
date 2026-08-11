#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import { parsePrepareArguments } from "./prepare-tauri-app.mjs";
import { signingConfigurationFromEnvironment } from "./windows-signing-policy.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const defaultTauriCliPath = path.join(
  projectRoot,
  "node_modules",
  "@tauri-apps",
  "cli",
  "tauri.js",
);
const platformNames = new Map([
  ["darwin", "macos"],
  ["win32", "windows"],
]);

function parseBuildArguments(argv, hostPlatform) {
  let dryRun = false;
  let signed = false;
  const prepareArguments = [];
  for (const argument of argv) {
    if (argument === "--dry-run") {
      if (dryRun) throw new Error("The --dry-run option may only be specified once");
      dryRun = true;
    } else if (argument === "--sign") {
      if (signed) throw new Error("The --sign option may only be specified once");
      signed = true;
    } else {
      prepareArguments.push(argument);
    }
  }
  return {
    dryRun,
    signed,
    request: parsePrepareArguments(prepareArguments, { hostPlatform }),
  };
}

export function createTauriBuildPlan(
  argv,
  {
    hostPlatform = process.platform,
    nodeExecutable = process.execPath,
    npmCliPath = process.env.npm_execpath,
    tauriCliPath = defaultTauriCliPath,
    environment = process.env,
  } = {},
) {
  const { dryRun, signed, request } = parseBuildArguments(argv, hostPlatform);
  const platformName = platformNames.get(request.platform);
  if (!platformName) {
    throw new Error(`Unsupported build platform: ${request.platform}`);
  }
  if (!npmCliPath) {
    throw new Error("The Tauri build must be started through an npm script");
  }
  if (signed && request.platform !== "win32") {
    throw new Error("The --sign option is currently supported only for Windows builds");
  }

  const tauriArguments = [tauriCliPath, "build", "--target", request.target];
  if (request.platform === "darwin") {
    tauriArguments.push("--bundles", "app,dmg");
  } else if (request.platform === "win32") {
    const windowsOverride = signed
      ? signingConfigurationFromEnvironment(environment).bundle.windows
      : undefined;
    tauriArguments.push("--bundles", "nsis");
    if (!signed) tauriArguments.push("--no-sign");
    tauriArguments.push(
      "--config",
      JSON.stringify({
        bundle: {
          createUpdaterArtifacts: false,
          ...(windowsOverride ? { windows: windowsOverride } : {}),
        },
      }),
    );
  }
  return {
    dryRun,
    signed,
    platform: request.platform,
    target: request.target,
    steps: [
      {
        name: `prepare-${platformName}`,
        command: nodeExecutable,
        args: [npmCliPath, "run", `app:prepare:${platformName}`],
        environment: {},
      },
      {
        name: "tauri-build",
        command: nodeExecutable,
        args: tauriArguments,
        environment: { CI: "true" },
      },
    ],
  };
}

export function executeTauriBuildPlan(
  plan,
  { spawnProcess = spawnSync, environment = process.env } = {},
) {
  for (const step of plan.steps) {
    const result = spawnProcess(step.command, step.args, {
      cwd: projectRoot,
      env: { ...environment, ...step.environment },
      shell: false,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`${step.name} exited with status ${result.status}`);
    }
  }
}

export function main(argv = process.argv.slice(2)) {
  const plan = createTauriBuildPlan(argv);
  if (plan.dryRun) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  executeTauriBuildPlan(plan);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
