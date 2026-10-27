import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ManagedAgentsCommandLostError,
  ManagedAgentsHitlRejectedError,
  ManagedAgentsSandboxGoneError,
  type ManagedAgentsClient,
  type ManagedAgentsCommandResult,
  type ManagedAgentsCheckpoint,
  type ManagedAgentsSession,
  type ManagedAgentsSessionInfo,
  type ManagedAgentsSessionState,
  type ManagedAgentsSessionSummary,
} from "../../src/sandbox/managed-agents-client.ts";
import { latestByName, readHostFile, remapScript, runShell, textResult, writeHostFile } from "./fake-provider-kit.ts";

const GUEST_ROOT = "/workspace";
const GUEST_ROOT_PREFIX = new RegExp(`(?<![A-Za-z0-9._-])${GUEST_ROOT}(?![A-Za-z0-9._-])`, "g");

export class FakeOutsideWorkspaceError extends Error {
  constructor(absPath: string) {
    super(`path outside workspace: ${JSON.stringify(absPath)} (workspace ${JSON.stringify(GUEST_ROOT)})`);
    this.name = "FakeOutsideWorkspaceError";
  }
}

interface FakeRecord {
  sessionId: string;
  sandboxId: string;
  name: string;
  state: ManagedAgentsSessionState;
  guestRoot: string;
  home: string;
  createdAt: number;
  loseNextCommand: boolean;
  rejectNextCommand: boolean;
  failNextCheckpoint: boolean;
  failNextCheckpointDelete: boolean;
  failNextRollback: boolean;
}

export interface FakeManagedAgents {
  client: ManagedAgentsClient;
  current(name: string): { sessionId: string; sandboxId: string; state: ManagedAgentsSessionState } | null;
  createdCount(name: string): number;
  homeDir(name: string): string;
  pause(name: string): void;
  destroy(name: string): void;
  loseNextCommand(name: string): void;
  rejectNextCommand(name: string): void;
  execScripts(): string[];
  pauseCalls(): string[];
  resumeCalls(): string[];
  guestDisconnects(): string[];
  checkpointCalls(): Array<{ sessionId: string; checkpointId: string; label?: string }>;
  deletedCheckpoints(): string[];
  rollbackCalls(): Array<{ sessionId: string; checkpointId: string }>;
  failNextCheckpoint(name: string): void;
  failNextCheckpointDelete(name: string): void;
  failNextRollback(name: string): void;
  cleanup(): void;
}

interface CallLog {
  execScripts: string[];
  pauseCalls: string[];
  resumeCalls: string[];
  guestDisconnects: string[];
  checkpointCalls: Array<{ sessionId: string; checkpointId: string; label?: string }>;
  deletedCheckpoints: string[];
  rollbackCalls: Array<{ sessionId: string; checkpointId: string }>;
}

interface MaState {
  root: string;
  records: Map<string, FakeRecord>;
  log: CallLog;
  seq: { id: number; sandbox: number; checkpoint: number; clock: number };
}

const gone = (state: ManagedAgentsSessionState): boolean =>
  state === "destroyed" || state === "destroying" || state === "failed";

const byName = (st: MaState, name: string): FakeRecord | undefined =>
  latestByName(
    st.records.values(),
    (r) => r.name === name,
    (r) => !gone(r.state),
  );

const unmap = (r: FakeRecord, out: string): string =>
  out.replaceAll(`${r.guestRoot}/tmp/`, "/tmp/").replaceAll(r.guestRoot, GUEST_ROOT);

function hostPathFor(r: FakeRecord, absPath: string): string {
  const clean = absPath.replace(/\/+$/, "");
  if (clean !== GUEST_ROOT && !clean.startsWith(`${GUEST_ROOT}/`)) throw new FakeOutsideWorkspaceError(absPath);
  if (clean.split("/").includes("..")) throw new FakeOutsideWorkspaceError(absPath);
  return r.guestRoot + clean.slice(GUEST_ROOT.length);
}

function alive(r: FakeRecord): void {
  if (gone(r.state)) throw new ManagedAgentsSandboxGoneError(r.sessionId, `status ${r.state}`);
  if (r.state === "paused") r.state = "ready";
}

function notGone(r: FakeRecord): void {
  if (gone(r.state)) throw new ManagedAgentsSandboxGoneError(r.sessionId, `status ${r.state}`);
}

function liveRecord(st: MaState, sessionId: string): FakeRecord {
  const r = st.records.get(sessionId);
  if (!r || gone(r.state)) throw new ManagedAgentsSandboxGoneError(sessionId, "session was not found");
  return r;
}

const info = (r: FakeRecord): ManagedAgentsSessionInfo => ({
  sessionId: r.sessionId,
  sandboxId: r.sandboxId,
  name: r.name,
  state: r.state,
  createdAtMs: r.createdAt,
});

function destroyRecord(r: FakeRecord): void {
  r.state = "destroyed";
  rmSync(r.guestRoot, { recursive: true, force: true });
}

function runCommand(st: MaState, r: FakeRecord, command: string): ManagedAgentsCommandResult {
  alive(r);
  if (r.loseNextCommand) {
    r.loseNextCommand = false;
    r.state = "destroyed";
    throw new ManagedAgentsCommandLostError(r.sessionId, "sandbox is not running anymore");
  }
  if (r.rejectNextCommand) {
    r.rejectNextCommand = false;
    throw new ManagedAgentsHitlRejectedError(r.sessionId);
  }
  st.log.execScripts.push(command);
  mkdirSync(join(r.guestRoot, "tmp"), { recursive: true });
  const script = remapScript(command, { home: r.home, root: r.guestRoot, guest: GUEST_ROOT_PREFIX });
  return textResult(runShell(script), (s) => unmap(r, s));
}

function maSession(st: MaState, r: FakeRecord): ManagedAgentsSession {
  return {
    sessionId: r.sessionId,
    sandboxId: r.sandboxId,
    async runCommand(command): Promise<ManagedAgentsCommandResult> {
      return runCommand(st, r, command);
    },
    async readFileBytes(absPath): Promise<Uint8Array | null> {
      alive(r);
      return readHostFile(hostPathFor(r, absPath));
    },
    async writeFileBytes(absPath, data): Promise<void> {
      alive(r);
      writeHostFile(hostPathFor(r, absPath), data);
    },
    async createCheckpoint(label?: string): Promise<ManagedAgentsCheckpoint> {
      notGone(r);
      if (r.failNextCheckpoint) {
        r.failNextCheckpoint = false;
        throw new Error("do-managed-agents create checkpoint: http 500 capture failed");
      }
      const checkpointId = `cp-${st.seq.checkpoint++}`;
      st.log.checkpointCalls.push({ sessionId: r.sessionId, checkpointId, ...(label ? { label } : {}) });
      return { checkpointId, status: "READY", createdAtMs: Date.now() };
    },
    async close(): Promise<void> {
      st.log.guestDisconnects.push(r.sessionId);
    },
    async pause(): Promise<void> {
      notGone(r);
      st.log.guestDisconnects.push(r.sessionId);
      st.log.pauseCalls.push(r.sessionId);
      r.state = "paused";
    },
    async resume(): Promise<void> {
      notGone(r);
      st.log.resumeCalls.push(r.sessionId);
      r.state = "ready";
    },
    async kill(): Promise<void> {
      st.log.guestDisconnects.push(r.sessionId);
      destroyRecord(r);
    },
  };
}

function createRecord(st: MaState, name: string): FakeRecord {
  const id = `sess-${st.seq.id++}`;
  const r: FakeRecord = {
    sessionId: id,
    sandboxId: `sbx-${id}`,
    name,
    state: "ready",
    guestRoot: join(st.root, id),
    home: join(st.root, id, "home"),
    createdAt: ++st.seq.clock,
    loseNextCommand: false,
    rejectNextCommand: false,
    failNextCheckpoint: false,
    failNextCheckpointDelete: false,
    failNextRollback: false,
  };
  mkdirSync(r.home, { recursive: true });
  st.records.set(id, r);
  return r;
}

function maClient(st: MaState): ManagedAgentsClient {
  return {
    async info(sessionId): Promise<ManagedAgentsSessionInfo> {
      return info(liveRecord(st, sessionId));
    },
    async create(opts): Promise<ManagedAgentsSession> {
      return maSession(st, createRecord(st, opts.name));
    },
    async connect(sessionId): Promise<ManagedAgentsSession> {
      const r = liveRecord(st, sessionId);
      if (r.state === "paused") {
        st.log.resumeCalls.push(r.sessionId);
        r.state = "ready";
      }
      return maSession(st, r);
    },
    async list(name): Promise<ManagedAgentsSessionSummary[]> {
      return [...st.records.values()]
        .filter((r) => !gone(r.state) && r.name === name)
        .map((r) => ({ sessionId: r.sessionId, sandboxId: r.sandboxId, name: r.name, state: r.state }));
    },
    async rollback(sessionId, checkpointId): Promise<ManagedAgentsSessionInfo> {
      const r = liveRecord(st, sessionId);
      if (r.failNextRollback) {
        r.failNextRollback = false;
        throw new Error("do-managed-agents rollback: http 409 checkpoint is not ready");
      }
      st.log.rollbackCalls.push({ sessionId, checkpointId });
      r.sandboxId = `sbx-restored-${st.seq.sandbox++}`;
      r.state = "ready";
      return info(r);
    },
    async deleteCheckpoint(sessionId, checkpointId): Promise<void> {
      const r = liveRecord(st, sessionId);
      if (r.failNextCheckpointDelete) {
        r.failNextCheckpointDelete = false;
        throw new Error("do-managed-agents delete checkpoint: http 500 delete failed");
      }
      st.log.deletedCheckpoints.push(checkpointId);
    },
    async kill(sessionId): Promise<void> {
      const r = st.records.get(sessionId);
      if (r) destroyRecord(r);
    },
  };
}

export function installFakeManagedAgents(): FakeManagedAgents {
  const st: MaState = {
    root: mkdtempSync(join(tmpdir(), "fake-managed-agents-")),
    records: new Map(),
    log: {
      execScripts: [],
      pauseCalls: [],
      resumeCalls: [],
      guestDisconnects: [],
      checkpointCalls: [],
      deletedCheckpoints: [],
      rollbackCalls: [],
    },
    seq: { id: 1, sandbox: 1, checkpoint: 1, clock: 0 },
  };
  const need = (name: string): FakeRecord => {
    const r = byName(st, name);
    if (!r) throw new Error(`fake-managed-agents: no session named ${name}`);
    return r;
  };
  const { log } = st;
  return {
    client: maClient(st),
    current: (name) => {
      const r = byName(st, name);
      return r && !gone(r.state) ? { sessionId: r.sessionId, sandboxId: r.sandboxId, state: r.state } : null;
    },
    createdCount: (name) => [...st.records.values()].filter((r) => r.name === name).length,
    homeDir: (name) => need(name).home,
    pause: (name) => {
      need(name).state = "paused";
    },
    destroy: (name) => destroyRecord(need(name)),
    loseNextCommand: (name) => {
      need(name).loseNextCommand = true;
    },
    rejectNextCommand: (name) => {
      need(name).rejectNextCommand = true;
    },
    checkpointCalls: () => [...log.checkpointCalls],
    deletedCheckpoints: () => [...log.deletedCheckpoints],
    failNextCheckpoint: (name) => {
      need(name).failNextCheckpoint = true;
    },
    failNextCheckpointDelete: (name) => {
      need(name).failNextCheckpointDelete = true;
    },
    rollbackCalls: () => [...log.rollbackCalls],
    failNextRollback: (name) => {
      need(name).failNextRollback = true;
    },
    execScripts: () => [...log.execScripts],
    pauseCalls: () => [...log.pauseCalls],
    resumeCalls: () => [...log.resumeCalls],
    guestDisconnects: () => [...log.guestDisconnects],
    cleanup: () => rmSync(st.root, { recursive: true, force: true }),
  };
}
