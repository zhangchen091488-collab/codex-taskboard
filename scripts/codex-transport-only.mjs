import {
  launchCodexAppWithPrivatePipe,
} from "../shared/codex-app-launch.mjs";
import {
  acquireCodexProfileLease,
  initializeIndependentCodexProfile,
} from "../shared/codex-profile.mjs";
import {
  errorCodexTransport,
  publishCodexTransportReadiness,
  readyCodexTransport,
} from "../shared/codex-transport-readiness.mjs";
import { CdpPipeBrowser } from "./codex-cdp-pipe.mjs";

function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child) {
  if (childHasExited(child)) return Promise.resolve(child.exitCode ?? 1);
  return new Promise((resolve, reject) => {
    const handleError = (error) => {
      child.removeListener("exit", handleExit);
      reject(error);
    };
    const handleExit = (code) => {
      child.removeListener("error", handleError);
      resolve(code);
    };
    child.once("error", handleError);
    child.once("exit", handleExit);
  });
}

async function stopChild(child, timeoutMs = 5_000) {
  if (!child || childHasExited(child)) return;
  const exited = waitForChildExit(child).then(() => true, () => true);
  child.kill("SIGTERM");
  if (await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ])) return;
  child.kill("SIGKILL");
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
}

export async function runCodexTransportOnly({
  appPath,
  profilePath,
  sourceProfilePath,
  readinessFile,
  readinessNonce,
  commandTimeoutMs = 30_000,
  dependencies = {},
}) {
  const initializeProfile = (
    dependencies.initializeIndependentCodexProfile
    ?? initializeIndependentCodexProfile
  );
  const acquireProfileLease = dependencies.acquireCodexProfileLease ?? acquireCodexProfileLease;
  const launch = dependencies.launchCodexAppWithPrivatePipe ?? launchCodexAppWithPrivatePipe;
  const publishReadiness = dependencies.publishCodexTransportReadiness
    ?? publishCodexTransportReadiness;
  const createBrowser = dependencies.createBrowser
    ?? ((child) => new CdpPipeBrowser(child, { commandTimeoutMs }));

  await initializeProfile({
    sourceProfilePath,
    destinationProfilePath: profilePath,
  });
  const profileLease = await acquireProfileLease(profilePath);
  let child;
  let browser;
  let ready = false;
  try {
    child = launch({ appPath, profilePath });
    browser = createBrowser(child);
    await browser.open();
    if (childHasExited(child)) {
      throw new Error("Codex exited before its private transport was ready");
    }
    await publishReadiness(readinessFile, readyCodexTransport(readinessNonce));
    ready = true;
    const exitCode = await waitForChildExit(child);
    return exitCode ?? 1;
  } catch (error) {
    if (!ready) {
      await publishReadiness(
        readinessFile,
        errorCodexTransport(readinessNonce),
      ).catch(() => {});
    }
    await stopChild(child);
    throw error;
  } finally {
    browser?.close();
    await profileLease.release();
  }
}
