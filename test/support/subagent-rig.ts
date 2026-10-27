import { createMailWaker, type MailWaker } from "../../src/subagents/mail-wake.ts";
import { createSessionMailbox, type SessionMailbox } from "../../src/sessions/session-mailbox.ts";
import assert from "node:assert/strict";
import { createMemoryRunSignalStore } from "../../src/runs/run-signal-store.ts";
import { createSessionSyscalls } from "../../src/subagents/session-tools.ts";
import { scopeId, type Conversation, type Principal, type ScopeId, type Session } from "../../src/types.ts";
import type { SessionStore } from "../../src/sessions/session-store.ts";
import type { RunStore } from "../../src/runs/run-store.ts";
import type { OrchestratorInput } from "../../src/core/orchestrator.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import type { AdvisoryLock } from "../../src/persistence/advisory-lock.ts";
import { testAdvisoryLock, testDatabaseUrl } from "./test-database.ts";
import { testRunStore, type TestRunStore } from "./turns.ts";

export const actor: Principal = { id: "U1", type: "internal", displayName: "Alex" };
export const scope: ScopeId = scopeId("personal", "U1");
export const conversation: Conversation = { kind: "dm", threadRef: "slack:dm:D1", audience: [actor] };

export interface Rig {
  mailbox: SessionMailbox;
  mailboxUrl: string;
  sessions: SessionStore;
  runs: RunStore;
  ledger: TestRunStore["ledger"];
  signals: ReturnType<typeof createMemoryRunSignalStore>;
  advisoryLock: AdvisoryLock;
  waker: MailWaker;
  room: Session;
  syscallsFor(session: Session): ReturnType<ReturnType<typeof createSessionSyscalls>["forTurn"]>;
}

const stores: TestRunStore[] = [];
export const closeRigStores = () => Promise.all(stores.splice(0).map((store) => store.close()));

export function runStore(): TestRunStore {
  const store = testRunStore();
  stores.push(store);
  return store;
}

export async function rig(opts?: {
  treeRunCap?: number;
  prepareRequest?: (request: OrchestratorInput) => Promise<OrchestratorInput>;
}): Promise<Rig> {
  const { runs, ledger, databaseUrl } = runStore();
  const sessions = createPostgresSessionStore(databaseUrl);
  const signals = createMemoryRunSignalStore();
  const mailboxUrl = testDatabaseUrl();
  const mailbox = createSessionMailbox(mailboxUrl);
  const advisoryLock = testAdvisoryLock();
  const waker = createMailWaker({
    mailbox,
    sessions,
    runs,
    lock: advisoryLock,
    maxAttempts: 3,
    delegationEnabled: async () => true,
    ...(opts?.prepareRequest ? { prepareRequest: opts.prepareRequest } : {}),
  });
  mailbox.onDelivered(waker.wake);
  const factory = createSessionSyscalls({
    mailbox,
    sessions,
    runs,
    signals,
    advisoryLock,
    maxAttempts: 3,
    ...(opts?.treeRunCap !== undefined ? { treeRunCap: opts.treeRunCap } : {}),
    ...(opts?.prepareRequest ? { prepareRequest: opts.prepareRequest } : {}),
  });
  const room = await sessions.getOrCreateByThread("slack:dm:D1", "dm", scope, undefined, "slack");
  await sessions.updateTitle(room.id, "dm with alex");
  await sessions.addParticipant(room.id, actor.id);
  const binding = (session: Session) => ({
    session,
    scopeId: scope,
    request: {
      surface: "slack",
      conversation,
      actor,
      deliveryTarget: "D1",
      timezone: "America/Los_Angeles",
    } as Pick<OrchestratorInput, "surface" | "conversation" | "actor" | "deliveryTarget" | "timezone" | "readOnly">,
  });
  return {
    mailbox,
    mailboxUrl,
    sessions,
    runs,
    ledger,
    signals,
    advisoryLock,
    waker,
    room,
    syscallsFor: (session) => factory.forTurn(binding(session)),
  };
}

export async function freshSession(sessions: SessionStore, id: string): Promise<Session> {
  const s = await sessions.get(id);
  assert.ok(s);
  return s;
}

export async function delegatedHumanRig(context: Partial<OrchestratorInput> = {}) {
  const r = await rig();
  const parent = await r.runs.enqueue({
    sessionId: r.room.threadRef,
    dedupKey: "human-authority",
    request: {
      actor,
      conversation,
      surface: "slack",
      origin: { kind: "human" },
      addressed: true,
      text: "inspect",
      ...context,
    },
  });
  const api = createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
    session: r.room,
    scopeId: scope,
    request: { ...parent.run.request, runId: parent.run.id },
  });
  const opened = await api.open({ task: "inspect" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const run = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  return { ...r, parent: parent.run, child, run, api };
}
