const DRAFTS_STORAGE_KEY = "web-ui:drafts";
const DRAFTS_CAP = 30;
const DRAFT_MAX_CHARS = 20_000;
const PERSIST_DEBOUNCE_MS = 400;

let cache: Map<string, string> | null = null;
let cachedRaw: string | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

export function newChatDraftKey(user: string | null | undefined): string {
  return `__new-chat__:${user ?? "anon"}`;
}

export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string | null): boolean {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function parsePairs(raw: string | null, cap: number): Map<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    if (Array.isArray(parsed))
      return new Map(
        parsed
          .filter(
            (p): p is [string, string] => Array.isArray(p) && typeof p[0] === "string" && typeof p[1] === "string",
          )
          .slice(-cap),
      );
  } catch {
    void 0;
  }
  return new Map();
}

export function clearAllDrafts(): void {
  dropPendingPersist();
  cache = null;
  cachedRaw = null;
  writeStorage(DRAFTS_STORAGE_KEY, null);
}

function loadDrafts(): Map<string, string> {
  const raw = readStorage(DRAFTS_STORAGE_KEY);
  if (cache && (persistTimer !== null || raw === cachedRaw)) return cache;
  cachedRaw = raw;
  cache = parsePairs(raw, DRAFTS_CAP);
  return cache;
}

function persistNow(): void {
  dropPendingPersist();
  if (!cache) return;
  const raw = JSON.stringify([...cache]);
  if (writeStorage(DRAFTS_STORAGE_KEY, raw)) cachedRaw = raw;
}

function schedulePersist(): void {
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, PERSIST_DEBOUNCE_MS);
  (persistTimer as { unref?: () => void }).unref?.();
}

function dropPendingPersist(): void {
  if (persistTimer === null) return;
  clearTimeout(persistTimer);
  persistTimer = null;
}

export function flushDrafts(): void {
  if (persistTimer !== null) persistNow();
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("pagehide", flushDrafts);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushDrafts();
  });
}

export function storedDraft(key: string): string {
  return loadDrafts().get(key) ?? "";
}

export function saveDraft(key: string, text: string): void {
  const drafts = loadDrafts();
  drafts.delete(key);
  if (text.trim()) {
    drafts.set(key, text.slice(0, DRAFT_MAX_CHARS));
    while (drafts.size > DRAFTS_CAP) drafts.delete(drafts.keys().next().value as string);
  }
  schedulePersist();
}

export function clearDraft(key: string): void {
  const drafts = loadDrafts();
  if (drafts.delete(key)) schedulePersist();
}
