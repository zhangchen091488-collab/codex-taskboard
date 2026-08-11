import os from "node:os";
import { pathToFileURL } from "node:url";

import { errorReadiness, listeningReadiness } from "../shared/taskboard-readiness.mjs";
import {
  createTaskboardServer,
  resolveHost,
  resolveLauncherPort,
  resolvePort,
  resolveServerOptions,
} from "./app.mjs";

export {
  createTaskboardServer,
  resolveHost,
  resolveLauncherPort,
  resolvePort,
  resolveServerOptions,
} from "./app.mjs";

export function resolveStartupListenOptions(environment = process.env) {
  const launcherMode = Boolean(String(environment.CODEX_TASKBOARD_INSTANCE_TOKEN ?? "").trim());
  const host = resolveHost(
    environment.CODEX_TASKBOARD_HOST ?? (launcherMode ? "127.0.0.1" : "0.0.0.0"),
  );
  if (launcherMode && host !== "127.0.0.1") {
    throw new Error("Launcher Taskboard server must bind to 127.0.0.1");
  }
  const rawPort = environment.CODEX_TASKBOARD_PORT ?? (launcherMode ? "0" : "47823");
  const port = launcherMode ? resolveLauncherPort(rawPort) : resolvePort(rawPort);
  return { host, port };
}

async function sendReadiness(message) {
  if (typeof process.send !== "function" || !process.connected) return;
  await new Promise((resolve, reject) => {
    process.send(message, (error) => error ? reject(error) : resolve());
  });
  if (process.env.CODEX_TASKBOARD_LAUNCHER_READINESS !== "1") {
    process.disconnect?.();
  }
}

export function isShutdownMessage(message) {
  return Boolean(
    message
    && typeof message === "object"
    && !Array.isArray(message)
    && message.type === "codex-taskboard:shutdown"
    && message.version === 1
    && Object.keys(message).length === 2
  );
}

function sanitizedStartupError(error, environment = process.env) {
  let output = error instanceof Error ? (error.stack || error.message) : String(error);
  for (const sensitiveValue of [
    environment.CODEX_TASKBOARD_INSTANCE_TOKEN,
    environment.CODEX_TASKBOARD_INSTANCE_SECRET,
  ]) {
    if (sensitiveValue) output = output.replaceAll(sensitiveValue, "[redacted]");
  }
  return output;
}

async function main() {
  const app = createTaskboardServer();
  const listenOptions = resolveStartupListenOptions();
  const address = await app.listen(listenOptions);
  await sendReadiness(listeningReadiness(address.port));
  console.log(`Codex Taskboard listening on http://127.0.0.1:${address.port}`);
  if (listenOptions.host === "0.0.0.0") {
    const addresses = Object.values(os.networkInterfaces())
      .flat()
      .filter((entry) => entry?.family === "IPv4" && !entry.internal)
      .map((entry) => entry.address);
    for (const lanAddress of [...new Set(addresses)]) {
      console.log(`Codex Taskboard available on LAN at http://${lanAddress}:${address.port}`);
    }
  }

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close();
  };
  process.once("SIGINT", () => close().then(() => process.exit(0)));
  process.once("SIGTERM", () => close().then(() => process.exit(0)));
  if (process.env.CODEX_TASKBOARD_LAUNCHER_READINESS === "1") {
    process.on("message", (message) => {
      if (isShutdownMessage(message)) close().then(() => process.exit(0));
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (error) => {
    await sendReadiness(errorReadiness()).catch(() => {});
    console.error(sanitizedStartupError(error));
    process.exitCode = 1;
  });
}
