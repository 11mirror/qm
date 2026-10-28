import { updateSession, type CoreSession } from "./core-bridge.ts";

export type SessionPatch = {
  title?: string | null;
  archived?: boolean;
  pinned?: boolean;
  color?: string | null;
  unread?: boolean;
};

const tails = new Map<string, Promise<void>>();
const versions = new Map<string, number>();
let generation = 0;
let epoch = 0;

export function sessionPatchGeneration(): number {
  return generation;
}

export function sessionPatchEpoch(): number {
  return epoch;
}

export function bumpSessionPatchEpoch(): void {
  epoch++;
}

export function resetSessionPatches(): void {
  generation++;
  epoch++;
  tails.clear();
  versions.clear();
}

export function queueSessionPatch(
  id: string,
  patch: SessionPatch,
  applyLatest: (session: CoreSession) => void,
): Promise<CoreSession> {
  epoch++;
  const version = (versions.get(id) ?? 0) + 1;
  const queuedIn = generation;
  versions.set(id, version);
  const prior = tails.get(id) ?? Promise.resolve();
  const request = prior
    .catch(() => undefined)
    .then(async () => {
      const { session } = await updateSession(id, patch);
      if (generation === queuedIn && versions.get(id) === version) applyLatest(session);
      return session;
    });
  const settle = (): void => {
    if (generation === queuedIn) epoch++;
  };
  tails.set(id, request.then(settle, settle));
  return request;
}
