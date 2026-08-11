import { spawnSync as defaultSpawnSync } from "node:child_process";
import path from "node:path";

import { withoutTaskboardLauncherEnvironment } from "../shared/codex-environment.mjs";
import { findResidentInjectorPids } from "./codex-injector-runtime.mjs";

function platformLabel(platform) {
  return platform === "win32" ? "Windows" : platform;
}

export function createInjectorDevelopmentDiscovery({
  platform = process.platform,
  spawnSync = defaultSpawnSync,
  env = process.env,
  currentPid = process.pid,
  injectorPath,
  projectRoot,
  defaultPort,
}) {
  const supportsAutomaticPortDiscovery = platform === "darwin";
  const commandEnv = withoutTaskboardLauncherEnvironment(env);

  function debuggingPorts(
    preferredPort,
    {
      portExplicit = false,
      optional = false,
      operation = "Attaching to an existing Codex window",
    } = {},
  ) {
    if (portExplicit) return [preferredPort];
    if (!supportsAutomaticPortDiscovery) {
      if (optional) return [];
      throw new Error(`${operation} on ${platformLabel(platform)} requires an explicit --port`);
    }

    const ports = new Set([preferredPort]);
    const processes = spawnSync("/bin/ps", ["-axo", "command="], {
      encoding: "utf8",
      env: commandEnv,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (processes.status !== 0) return [...ports];

    for (const command of processes.stdout.split("\n")) {
      if (!command.includes("/ChatGPT.app/") && !command.includes("/Codex.app/")) continue;
      const match = command.match(/--remote-debugging-port=(\d+)/);
      if (match) ports.add(Number(match[1]));
    }
    return [...ports];
  }

  function processCwd(pid) {
    const result = spawnSync("/usr/sbin/lsof", [
      "-a",
      "-p",
      String(pid),
      "-d",
      "cwd",
      "-Fn",
    ], {
      encoding: "utf8",
      env: commandEnv,
      maxBuffer: 64 * 1024,
    });
    if (result.status !== 0) return null;
    const cwd = result.stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1);
    return cwd ? path.resolve(cwd) : null;
  }

  function residentInjectorPids(port) {
    if (platform !== "darwin") return [];
    const processes = spawnSync("/bin/ps", ["-axo", "pid=,command="], {
      encoding: "utf8",
      env: commandEnv,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (processes.status !== 0) return [];
    return findResidentInjectorPids({
      processList: processes.stdout,
      currentPid,
      injectorPath,
      projectRoot,
      port,
      defaultPort,
      cwdForPid: processCwd,
    });
  }

  function assertExternalCdpPort({ launch, cdpPipe, portExplicit }) {
    if (launch || cdpPipe || portExplicit || supportsAutomaticPortDiscovery) return;
    throw new Error(
      `Attaching to an existing Codex window on ${platformLabel(platform)} requires an explicit --port`,
    );
  }

  return {
    assertExternalCdpPort,
    debuggingPorts,
    residentInjectorPids,
    supportsAutomaticPortDiscovery,
  };
}
