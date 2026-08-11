import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
const runtimeSource = await readFile(
  new URL("../scripts/codex-injector-runtime.mjs", import.meta.url),
  "utf8",
);
const discoverySource = await readFile(
  new URL("../scripts/codex-injector-discovery.mjs", import.meta.url),
  "utf8",
);
const supervisorSource = await readFile(
  new URL("../scripts/taskboard-supervisor.mjs", import.meta.url),
  "utf8",
);
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("the resident injector authenticates its launcher-managed Taskboard service", () => {
  assert.match(supervisorSource, /function createTaskboardSupervisor/);
  assert.match(source, /CODEX_TASKBOARD_INSTANCE_TOKEN/);
  assert.match(source, /createHmac\("sha256"/);
  assert.match(source, /x-codex-taskboard-challenge/);
  assert.match(source, /proof/);
  assert.match(source, /taskboardInstanceSecret/);
  assert.match(source, /Page\.setDocumentContent/);
  assert.match(runtimeSource, /request\.action === "load-frame"/);
  assert.match(supervisorSource, /ensureInFlight/);
  assert.match(
    supervisorSource,
    /await terminateManagedChild\(managedChild, \{ detached, platform \}\)/,
  );
  assert.match(supervisorSource, /type: "codex-taskboard:shutdown"/);
  assert.match(source, /await supervisor\.ensure\(\)/);
  assert.match(source, /it will be restarted automatically/);
  assert.match(source, /AbortSignal\.timeout\(1_500\)/);
  assert.match(source, /version: 2/);
  assert.match(source, /startupNonce: taskboardInstanceToken/);
  assert.match(source, /host: endpoint\.hostname/);
  assert.match(source, /port: Number\(endpoint\.port\)/);
  assert.match(source, /__CODEX_TASKBOARD_FRAME_CAPABILITY__/);
  assert.match(runtimeSource, /request\.frameCapability/);
});

test("the CDP bridge accepts service ensure and native instruction composer prefill actions", () => {
  assert.match(source, /const hostBindingName = "__codexTaskboardHostV1"/);
  assert.match(runtimeSource, /request\.action === "ensure"/);
  assert.match(runtimeSource, /request\.action === "prefill-task-composer"/);
  assert.match(runtimeSource, /request\.action === "open-external"/);
  assert.match(runtimeSource, /request\.instruction\.length <= 1_024/);
  assert.match(source, /function prefillTaskComposerViaCdp/);
  assert.match(source, /cdp\.send\("Input\.insertText", \{ text: instruction \}\)/);
  assert.match(source, /Runtime\.bindingCalled/);
  assert.match(source, /Page\.createIsolatedWorld/);
  assert.match(source, /Runtime\.addBinding", \{\s*name: hostBindingName,\s*executionContextId:/);
  assert.match(source, /params\.executionContextId !== activeContextId/);
  assert.match(runtimeSource, /params\.executionContextId/);
  assert.match(source, /hostResponseMessage/);
  assert.match(source, /if \(keepAlive\) await hostBridge\.install\(\)/);
  assert.match(source, /hostBridge\.publishHeartbeat/);
  assert.match(source, /withoutTaskboardLauncherEnvironment\(process\.env\)/);
});

test("the CDP bridge exposes only the fixed Taskboard automation operations", () => {
  assert.match(source, /parseTaskboardAutomationHostRequest/);
  assert.match(source, /reconcileTaskboardAutomation/);
  assert.match(runtimeSource, /request\.action === "automation"/);
  assert.match(source, /function requestCodexAutomationViaCdp/);
  assert.match(source, /new Set\(\[\s*"list-automations",\s*"automation-create",\s*"automation-update",\s*\]\)/);
  assert.match(source, /bridge\.sendMessageFromView\(\{\s*type: "fetch",\s*requestId,/);
  assert.match(source, /method: "POST"/);
  assert.match(source, /vscode:\/\/codex\/\$\{method\}/);
  assert.match(source, /body: JSON\.stringify\(params\)/);
  assert.match(source, /message\.type !== "fetch-response"/);
  assert.match(source, /message\.responseType/);
  assert.match(source, /message\.status/);
  assert.match(source, /message\.bodyJsonString/);
  assert.doesNotMatch(source, /automation-delete/);
  assert.doesNotMatch(source, /automations\.toml/);
});

test("passive automation policy keeps idle pauses and only resumes quota pauses", () => {
  assert.match(source, /taskboardAutomationPolicyOperation/);
  assert.match(source, /previousQuotaState: current\.quota\?\.state/);
  assert.match(source, /enqueueQuotaPolicyMutation\(record, rpc, \{ explicit: true \}\)/);
  assert.match(
    source,
    /!explicit && result\.operation === "list" && result\.item\?\.status === "PAUSED"/,
  );
  assert.match(source, /enabledByUser: false/);
  assert.match(source, /record\.quota \? \{ quota: record\.quota \} : \{\}/);
});

test("the package injection command remains resident for tab-triggered recovery", () => {
  assert.match(packageJson.scripts["codex:inject"], /--watch/);
  assert.match(packageJson.scripts["codex:daemon"], /--daemon --open/);
  assert.match(source, /function startResidentInjector/);
  assert.match(source, /const defaultCodexDebuggingPort = 9229/);
  assert.match(source, /port: defaultCodexDebuggingPort/);
  assert.match(source, /--startup-token/);
  assert.match(source, /__codexTaskboardHostStartupTokenV1/);
});

test("attach reconciles the renderer against a hashed current injection source", () => {
  assert.match(source, /createHash\("sha256"\)/);
  assert.match(source, /__CODEX_TASKBOARD_SOURCE_HASH__/);
  assert.match(source, /sourceHash: window\.__codexTaskboardInjection__\?\.sourceHash \|\| null/);
  assert.match(source, /const injectionScriptIdentifierName = "__CODEX_TASKBOARD_SCRIPT_IDENTIFIER__"/);
  assert.match(source, /scriptIdentifier: window\[\$\{JSON\.stringify\(injectionScriptIdentifierName\)\}\] \|\| null/);
  assert.match(source, /Page\.removeScriptToEvaluateOnNewDocument/);
  assert.match(source, /Page\.addScriptToEvaluateOnNewDocument/);
  assert.match(source, /reconcileInjectionRuntime/);
  assert.match(source, /expectedSourceHash/);
});

test("the injector ignores auxiliary Codex windows", () => {
  assert.match(source, /!target\.url\?\.includes\("initialRoute=%2Fglobal-dictation"\)/);
});

test("private-pipe injection visits every eligible renderer window and contains CSP failures", () => {
  assert.match(source, /targets: async \(\) => \(await browser\.targets\(\)\)[\s\S]*?\.filter\(isCodexTarget\)/);
  assert.match(source, /for \(const target of targets\) \{[\s\S]*?injectTarget\(/);
  assert.match(source, /if \(injectedTargets\.has\(target\.id\)\) continue/);
  assert.match(source, /evaluation\.exceptionDetails/);
  assert.match(source, /Taskboard injection failed/);
  assert.match(source, /if \(!options\.watch\) throw error/);
  assert.match(source, /Waiting for Codex renderer/);
});

test("Codex exit handling uses one normal-idle versus crash-restart decision", () => {
  assert.match(runtimeSource, /function codexProcessDisposition/);
  assert.match(source, /codexProcessDisposition\(codexProcess\)/);
  assert.match(source, /CODEX_PROCESS_DISPOSITION\.IDLE/);
  assert.match(source, /CODEX_PROCESS_DISPOSITION\.RUNNING/);
  assert.match(source, /idleAfterNormalExit = true/);
  assert.doesNotMatch(source, /launchedCodex\?\.exitCode === 0/);
});

test("a completed web build refreshes an already-open Codex iframe", () => {
  assert.match(packageJson.scripts.build, /--refresh-if-running/);
  assert.match(packageJson.scripts["codex:refresh"], /--refresh/);
  assert.match(source, /async function refreshTaskboardFrames/);
  assert.match(source, /injectorDiscovery\.debuggingPorts/);
  assert.match(source, /--remote-debugging-port=/);
  assert.match(source, /taskboard\.reloadFrame\(\)/);
  assert.match(source, /__codex_taskboard_refresh/);
  assert.match(source, /await restartResidentInjectorForRefresh\(port\)/);
});

test("release injector startup does not contain ps or lsof discovery", () => {
  assert.doesNotMatch(source, /spawnSync|\/bin\/ps|\/usr\/sbin\/lsof/);
  assert.match(discoverySource, /createInjectorDevelopmentDiscovery/);
  assert.match(discoverySource, /platform === "darwin"/);
  assert.match(discoverySource, /\/bin\/ps/);
  assert.match(discoverySource, /\/usr\/sbin\/lsof/);
  assert.doesNotMatch(discoverySource, /powershell|wmic|tasklist/i);
});

test("the injected iframe follows the configured local service port", () => {
  assert.match(source, /taskboardBaseUrl = `\$\{taskboardOrigin\}\/\$\{encodeURIComponent\(taskboardInstanceToken\)\}`/);
  assert.match(source, /taskboardPageUrl = `\$\{taskboardBaseUrl\}\/\?host=codex`/);
  assert.match(source, /configureTaskboardEndpoint\(resolveLauncherPort\(\)\)/);
  assert.match(source, /onReadiness: \(readiness\) => configureTaskboardEndpoint\(readiness\.port\)/);
  assert.match(source, /window\.__CODEX_TASKBOARD_URL__ = \$\{JSON\.stringify\(taskboardPageUrl\)\}/);
});

test("the complete private-pipe injector publishes the same nonce readiness after handshake", () => {
  assert.match(source, /readyCodexTransport/);
  assert.match(source, /errorCodexTransport/);
  assert.match(source, /publishCodexTransportReadiness/);
  assert.match(
    source,
    /transport readiness options require --transport-only or --launch --watch --cdp-pipe/,
  );
  const launchBranch = source.slice(
    source.indexOf("if (options.cdpPipe) {", source.indexOf("async function main")),
    source.indexOf("} else if (!cdpReachable)", source.indexOf("async function main")),
  );
  assert.match(launchBranch, /await launchCodexWithPipe\(options\.appPath\)/);
  assert.match(launchBranch, /await publishFullTransportReadiness\(options, true\)/);
  assert.match(launchBranch, /await publishFullTransportReadiness\(options, false\)/);
  assert.doesNotMatch(launchBranch, /remote-debugging-port|WebSocket/);
});
