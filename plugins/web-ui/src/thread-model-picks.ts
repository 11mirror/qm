import type { ModelOptionValue } from "./model-options";
import { parsePairs, readStorage, writeStorage } from "./drafts";

const THREAD_PICKS_STORAGE_KEY = "web-ui:model-picks";
const THREAD_PICKS_CAP = 50;
function loadThreadPicks(): Map<string, ModelOptionValue> {
  return parsePairs(readStorage(THREAD_PICKS_STORAGE_KEY), THREAD_PICKS_CAP);
}

let threadModelPicks = loadThreadPicks();

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === THREAD_PICKS_STORAGE_KEY) threadModelPicks = loadThreadPicks();
  });
}

export function rememberThreadPick(threadRef: string, value: ModelOptionValue): void {
  const merged = loadThreadPicks();
  for (const [ref, pick] of threadModelPicks) if (!merged.has(ref)) merged.set(ref, pick);
  merged.delete(threadRef);
  merged.set(threadRef, value);
  while (merged.size > THREAD_PICKS_CAP) merged.delete(merged.keys().next().value as string);
  threadModelPicks = merged;
  writeStorage(THREAD_PICKS_STORAGE_KEY, JSON.stringify([...merged]));
}

export function forgetThreadPick(threadRef: string): void {
  threadModelPicks = loadThreadPicks();
  threadModelPicks.delete(threadRef);
  writeStorage(THREAD_PICKS_STORAGE_KEY, JSON.stringify([...threadModelPicks]));
}

export function carryModelPick(fromThreadRef: string | null, toThreadRef: string): void {
  const pick = fromThreadRef ? threadModelPicks.get(fromThreadRef) : undefined;
  if (pick) rememberThreadPick(toThreadRef, pick);
}

export function threadModelPick(threadRef: string): ModelOptionValue | undefined {
  return threadModelPicks.get(threadRef);
}

export function hasThreadModelPick(threadRef: string): boolean {
  return threadModelPicks.has(threadRef);
}
