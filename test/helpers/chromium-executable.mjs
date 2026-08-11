import { access } from "node:fs/promises";
import path from "node:path";

export function chromiumCandidates(environment = process.env) {
  const windowsRoots = [
    environment.PROGRAMFILES,
    environment["PROGRAMFILES(X86)"],
    environment.LOCALAPPDATA,
  ].filter(Boolean);
  return [
    environment.CHROME_PATH,
    environment.CHROME_BIN,
    ...windowsRoots.flatMap((root) => [
      path.win32.join(root, "Google", "Chrome", "Application", "chrome.exe"),
      path.win32.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
    ]),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
}

export async function findChromiumExecutable(environment = process.env) {
  for (const candidate of chromiumCandidates(environment)) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return null;
}
