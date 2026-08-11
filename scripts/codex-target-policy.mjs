export function isCodexTarget(target) {
  return (
    target?.type === "page"
    && !target.url?.includes("initialRoute=%2Fglobal-dictation")
    && !target.url?.includes("initialRoute=%2Favatar-overlay")
    && (target.url?.startsWith("app://") || target.title === "Codex")
  );
}
