import { cpSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ModalNameConflictError,
  ModalSandboxGoneError,
  type ModalClient,
  type ModalCommandResult,
  type ModalSession,
} from "../../src/sandbox/modal-client.ts";
import { latestByName, readHostFile, remapScript, runShell, textResult, writeHostFile } from "./fake-provider-kit.ts";

interface FakeRecord {
  sandboxId: string;
  name?: string;
  tags: Record<string, string>;
  state: "running" | "terminated";
  home: string;
  createdAt: number;
}

export interface FakeModal {
  client: ModalClient;
  current(name: string): { sandboxId: string; state: string } | null;
  createdCount(name: string): number;
  totalCreated(): number;
  runningCount(): number;
  homeDir(name: string): string;
  terminate(name: string): void;
  terminateAllRunning(): void;
  failTerminateOnce(): void;
  holdNameAfterTerminate(createAttempts: number): void;
  execScripts(): string[];
  tagsOf(sandboxId: string): Record<string, string>;
  createUntracked(tags: Record<string, string>): string;
  onSnapshot(hook: (() => Promise<void>) | null): void;
  snapshotCount(): number;
  failRestoreOnce(): void;
  cleanup(): void;
}

interface ModalState {
  root: string;
  records: Map<string, FakeRecord>;
  execScripts: string[];
  heldNames: Map<string, number>;
  seq: { id: number; clock: number };
  faults: { terminate: number; restore: number; nameHold: number };
  snap: { count: number; hook: (() => Promise<void>) | null };
}

const GUEST_ROOT = /\/root(?![A-Za-z0-9_-])/;

const byName = (st: ModalState, name: string): FakeRecord | undefined =>
  latestByName(
    st.records.values(),
    (r) => r.name === name,
    (r) => r.state === "running",
  );

const hostPath = (r: FakeRecord, absPath: string): string =>
  absPath.replace(new RegExp(`^${GUEST_ROOT.source}`), r.home);

function alive(r: FakeRecord): void {
  if (r.state === "terminated") throw new ModalSandboxGoneError(r.sandboxId, "sandbox has been terminated");
}

function kill(st: ModalState, r: FakeRecord): void {
  if (st.faults.nameHold > 0 && r.name) st.heldNames.set(r.name, st.faults.nameHold);
  st.faults.nameHold = 0;
  r.state = "terminated";
  rmSync(r.home, { recursive: true, force: true });
}

function modalSession(st: ModalState, r: FakeRecord): ModalSession {
  return {
    sandboxId: r.sandboxId,
    async snapshotHome(): Promise<string> {
      alive(r);
      st.snap.count++;
      await st.snap.hook?.();
      const imageId = `im-${st.seq.id++}`;
      cpSync(r.home, join(st.root, imageId), { recursive: true });
      return imageId;
    },
    async restoreHome(imageId: string): Promise<void> {
      alive(r);
      if (st.faults.restore > 0) {
        st.faults.restore--;
        throw new Error("simulated restore outage");
      }
      rmSync(r.home, { recursive: true, force: true });
      cpSync(join(st.root, imageId), r.home, { recursive: true });
    },
    async runCommand(command, runOpts): Promise<ModalCommandResult> {
      alive(r);
      st.execScripts.push(command);
      mkdirSync(join(r.home, "tmp"), { recursive: true });
      const script = remapScript(command, { home: r.home, guest: new RegExp(GUEST_ROOT.source, "g") });
      return textResult(runShell(script, { ...(runOpts?.env ? { env: runOpts.env } : {}) }));
    },
    async readFileBytes(absPath): Promise<Uint8Array | null> {
      alive(r);
      return readHostFile(hostPath(r, absPath));
    },
    async writeFileBytes(absPath, data): Promise<void> {
      alive(r);
      writeHostFile(hostPath(r, absPath), data);
    },
    async terminate(): Promise<void> {
      if (st.faults.terminate > 0) {
        st.faults.terminate--;
        throw new Error("simulated terminate outage");
      }
      kill(st, r);
    },
  };
}

function spawnRecord(st: ModalState, name: string | undefined, tags: Record<string, string>): FakeRecord {
  const id = `sb-${st.seq.id++}`;
  const r: FakeRecord = {
    sandboxId: id,
    ...(name ? { name } : {}),
    tags,
    state: "running",
    home: join(st.root, id),
    createdAt: ++st.seq.clock,
  };
  mkdirSync(r.home, { recursive: true });
  st.records.set(id, r);
  return r;
}

function modalClient(st: ModalState): ModalClient {
  return {
    lifetimeMs: 24 * 3600_000,
    async create(opts): Promise<ModalSession> {
      if (opts.name) {
        const held = st.heldNames.get(opts.name) ?? 0;
        if (held > 0) {
          st.heldNames.set(opts.name, held - 1);
          throw new ModalNameConflictError(opts.name, "sandbox with this name already exists");
        }
        const existing = byName(st, opts.name);
        if (existing && existing.state === "running") {
          throw new ModalNameConflictError(opts.name, "sandbox with this name already exists");
        }
      }
      return modalSession(st, spawnRecord(st, opts.name, opts.tags ?? {}));
    },
    async fromId(sandboxId): Promise<ModalSession> {
      const r = st.records.get(sandboxId);
      if (!r || r.state === "terminated") throw new ModalSandboxGoneError(sandboxId, "sandbox not found");
      return modalSession(st, r);
    },
    async fromName(name): Promise<ModalSession | null> {
      const r = byName(st, name);
      if (!r || r.state === "terminated") return null;
      return modalSession(st, r);
    },
    async terminate(sandboxId): Promise<void> {
      const r = st.records.get(sandboxId);
      if (!r) return;
      kill(st, r);
    },
    async *listRunning(tags): AsyncIterable<string> {
      for (const r of st.records.values()) {
        if (r.state !== "running") continue;
        if (Object.entries(tags).every(([k, v]) => r.tags[k] === v)) yield r.sandboxId;
      }
    },
  };
}

export function installFakeModal(): FakeModal {
  const st: ModalState = {
    root: mkdtempSync(join(tmpdir(), "fake-modal-")),
    records: new Map(),
    execScripts: [],
    heldNames: new Map(),
    seq: { id: 1, clock: 0 },
    faults: { terminate: 0, restore: 0, nameHold: 0 },
    snap: { count: 0, hook: null },
  };
  return {
    client: modalClient(st),
    current: (name) => {
      const r = byName(st, name);
      return r && r.state === "running" ? { sandboxId: r.sandboxId, state: r.state } : null;
    },
    createdCount: (name) => [...st.records.values()].filter((r) => r.name === name).length,
    totalCreated: () => st.records.size,
    runningCount: () => [...st.records.values()].filter((r) => r.state === "running").length,
    homeDir: (name) => {
      const r = byName(st, name);
      if (!r) throw new Error(`fake-modal: no sandbox named ${name}`);
      return r.home;
    },
    terminate: (name) => {
      const r = byName(st, name);
      if (r) kill(st, r);
    },
    terminateAllRunning: () => {
      for (const r of st.records.values()) if (r.state === "running") kill(st, r);
    },
    failTerminateOnce: () => {
      st.faults.terminate++;
    },
    holdNameAfterTerminate: (createAttempts) => {
      st.faults.nameHold = createAttempts;
    },
    execScripts: () => [...st.execScripts],
    tagsOf: (sandboxId) => {
      const r = st.records.get(sandboxId);
      if (!r) throw new Error(`fake-modal: no sandbox ${sandboxId}`);
      return { ...r.tags };
    },
    createUntracked: (tags) => spawnRecord(st, undefined, tags).sandboxId,
    onSnapshot: (hook) => {
      st.snap.hook = hook;
    },
    snapshotCount: () => st.snap.count,
    failRestoreOnce: () => {
      st.faults.restore++;
    },
    cleanup: () => rmSync(st.root, { recursive: true, force: true }),
  };
}
