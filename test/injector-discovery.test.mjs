import assert from "node:assert/strict";
import { test } from "node:test";

import { createInjectorDevelopmentDiscovery } from "../scripts/codex-injector-discovery.mjs";

const projectRoot = "/workspace/codex-taskboard";
const injectorPath = `${projectRoot}/scripts/codex-injector.mjs`;

test("Windows attach discovery requires an explicit debugging port without process scans", () => {
  const calls = [];
  const discovery = createInjectorDevelopmentDiscovery({
    platform: "win32",
    spawnSync: (...args) => calls.push(args),
    injectorPath,
    projectRoot,
    defaultPort: 9229,
  });

  assert.equal(discovery.supportsAutomaticPortDiscovery, false);
  assert.throws(
    () => discovery.debuggingPorts(9229, { operation: "Attaching" }),
    /Attaching on Windows requires an explicit --port/,
  );
  assert.deepEqual(discovery.debuggingPorts(9231, { portExplicit: true }), [9231]);
  assert.deepEqual(discovery.debuggingPorts(9229, { optional: true }), []);
  assert.throws(
    () => discovery.assertExternalCdpPort({
      launch: false,
      cdpPipe: false,
      portExplicit: false,
    }),
    /existing Codex window on Windows requires an explicit --port/,
  );
  assert.doesNotThrow(() => discovery.assertExternalCdpPort({
    launch: false,
    cdpPipe: false,
    portExplicit: true,
  }));
  assert.doesNotThrow(() => discovery.assertExternalCdpPort({
    launch: true,
    cdpPipe: true,
    portExplicit: false,
  }));
  assert.deepEqual(discovery.residentInjectorPids(9231), []);
  assert.deepEqual(calls, []);
});

test("macOS development discovery keeps ps and lsof behind the platform adapter", () => {
  const calls = [];
  const discovery = createInjectorDevelopmentDiscovery({
    platform: "darwin",
    currentPid: 999,
    injectorPath,
    projectRoot,
    defaultPort: 9229,
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      if (command === "/usr/sbin/lsof") {
        return { status: 0, stdout: `p${args[2]}\nn${projectRoot}\n` };
      }
      if (args.includes("command=")) {
        return {
          status: 0,
          stdout: [
            "/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9333",
            "/Applications/Other.app/Contents/MacOS/Other --remote-debugging-port=9444",
          ].join("\n"),
        };
      }
      return {
        status: 0,
        stdout: [
          `101 node ${injectorPath} --watch --port 9333`,
          "102 node scripts/codex-injector.mjs --watch --port 9333",
          `103 node ${injectorPath} --watch --port 9229`,
        ].join("\n"),
      };
    },
  });

  assert.equal(discovery.supportsAutomaticPortDiscovery, true);
  assert.deepEqual(discovery.debuggingPorts(9229), [9229, 9333]);
  assert.deepEqual(discovery.residentInjectorPids(9333), [101, 102]);
  assert.equal(calls.filter((call) => call.command === "/bin/ps").length, 2);
  assert.equal(calls.filter((call) => call.command === "/usr/sbin/lsof").length, 1);
  assert.equal(calls.every((call) => call.options.shell === undefined), true);
});
