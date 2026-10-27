import { swallowAs } from "../util/errors.ts";
import { type Session } from "../types.ts";
import type { Run, RunStore } from "../runs/run-store.ts";
import type { RunSignalStore } from "../runs/run-signal-store.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";

export const SUBAGENT_TREE_RUN_CAP = 50;

async function sessionAncestors(sessions: Pick<SessionStore, "get">, session: Session): Promise<Session[]> {
  const ancestors: Session[] = [];
  let current = session;
  const seen = new Set<string>();
  while (current.parentSessionId) {
    if (seen.has(current.id)) throw new Error("session parent cycle");
    seen.add(current.id);
    const parent = await sessions.get(current.parentSessionId);
    if (!parent) break;
    ancestors.push(parent);
    current = parent;
  }
  return ancestors;
}

export async function sessionTreeRoot(sessions: Pick<SessionStore, "get">, session: Session): Promise<Session> {
  return (await sessionAncestors(sessions, session)).at(-1) ?? session;
}

export const sessionTreeAdmissionKey = (root: Pick<Session, "id">): string => `session-tree-admission:${root.id}`;

export async function withSessionTreeLock<T>(
  lock: Pick<AdvisoryLock, "withLock">,
  sessions: Pick<SessionStore, "get">,
  session: Session,
  fn: () => Promise<T>,
): Promise<T> {
  return lock.withLock(sessionTreeAdmissionKey(await sessionTreeRoot(sessions, session)), fn);
}

export async function stoppableAncestors(sessions: Pick<SessionStore, "get">, session: Session): Promise<Session[]> {
  return (await sessionAncestors(sessions, session)).filter((ancestor) => ancestor.scopeId === session.scopeId);
}

export async function sessionTreeWorking(
  sessions: Pick<SessionStore, "descendantsOf">,
  runs: Pick<RunStore, "activeForThread">,
  root: Session,
): Promise<boolean> {
  for (const session of await treeSessions(sessions, root)) {
    if (session.scopeId === root.scopeId && (await runs.activeForThread(session.threadRef))) return true;
  }
  return false;
}

export async function workingSessionThreadRefs(
  sessions: Pick<SessionStore, "get" | "getByThread">,
  runs: Pick<RunStore, "activeSessionIds">,
  awaitingSessionIds: ReadonlySet<string>,
): Promise<Set<string>> {
  const active = await runs.activeSessionIds();
  const working = new Set(active);
  await Promise.all(
    active
      .map(async (threadRef) => {
        const session = await sessions.getByThread(threadRef);
        if (!session?.parentSessionId) return;
        for (const ancestor of await stoppableAncestors(sessions, session))
          if (!awaitingSessionIds.has(ancestor.id)) working.add(ancestor.threadRef);
      })
      .map((lookup) => lookup.catch(swallowAs("session list: working ancestors", undefined))),
  );
  return working;
}

type TreeNode = Pick<Session, "id" | "threadRef" | "scopeId">;

/** The root and every descendant, in one recursive query. */
async function treeSessions(sessions: Pick<SessionStore, "descendantsOf">, root: Session): Promise<TreeNode[]> {
  return [root, ...(await sessions.descendantsOf([root.id])).filter((node) => node.id !== root.id)];
}

export async function sessionRunCancelled(
  runs: Pick<RunStore, "get">,
  signals: Pick<RunSignalStore, "pending">,
  runId: string | undefined,
): Promise<boolean> {
  const seen = new Set<string>();
  while (runId) {
    if (seen.has(runId)) return true;
    seen.add(runId);
    const run = await runs.get(runId);
    if (!run) return true;
    if (run.result?.stopped || (await signals.pending(runId)).some(({ signal }) => signal.kind === "abort"))
      return true;
    runId = run.request.delegatingRunId;
  }
  return false;
}

export async function stopSessionTree(
  deps: {
    sessions: Pick<SessionStore, "descendantsOf">;
    runs: Pick<RunStore, "inFlightForThread" | "cancelTree">;
    signals: Pick<RunSignalStore, "send">;
  },
  root: Session,
  reason?: string,
): Promise<boolean> {
  const tree = (await treeSessions(deps.sessions, root)).filter((session) => session.scopeId === root.scopeId);
  const inFlight: Run[] = [];
  for (const session of tree) inFlight.push(...(await deps.runs.inFlightForThread(session.threadRef)));
  for (const run of inFlight) await deps.signals.send(run.id, { kind: "abort", ...(reason ? { reason } : {}) });
  await deps.runs.cancelTree(tree.map((session) => session.threadRef));
  return inFlight.length > 0;
}

export async function sessionTreeRunCount(
  sessions: Pick<SessionStore, "descendantsOf">,
  runs: Pick<RunStore, "inFlightForThread">,
  root: Session,
): Promise<number> {
  let live = 0;
  for (const session of await treeSessions(sessions, root)) {
    live += (await runs.inFlightForThread(session.threadRef)).length;
  }
  return live;
}
