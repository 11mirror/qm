import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  E2bCommandLostError,
  E2bSandboxGoneError,
  type E2bClient,
  type E2bCommandResult,
  type E2bMetrics,
  type E2bSession,
} from "../../src/sandbox/e2b-client.ts";
import { latestByName, readHostFile, remapScript, runShell, textResult, writeHostFile } from "./fake-provider-kit.ts";

interface FakeRecord {
  sandboxId: string;
  state: "running" | "paused";
  expired: boolean;
  autoPause: boolean;
  metadata: Record<string, string>;
  home: string;
  createdAt: number;
  fromSnapshot?: string;
  timeoutMs: number[];
  loseNextCommand: boolean;
  autoResume: boolean;
  createTimeoutMs?: number;
}

export interface FakeE2b {
  client: E2bClient;
  current(name: string): { sandboxId: string; state: string; metadata: Record<string, string> } | null;
  createdCount(name: string): number;
  homeDir(name: string): string;
  pause(name: string): void;

  expirePaused(): void;
  loseNextCommand(name: string): void;
  timeouts(name: string): number[];
  createOptions(name: string): { autoPause: boolean; autoResume: boolean; timeoutMs?: number };
  snapshots(): string[];
  restoredFrom(name: string): string | undefined;
  metrics: E2bMetrics | null;
  execScripts(): string[];
  cleanup(): void;
}

const OWNER_ENV = "QM_FAKE_E2B_OWNER";

function ownedPids(owner: string): number[] {
  const tag = `${OWNER_ENV}=${owner}`;
  const owned = (kv: string): boolean => kv === tag || kv.startsWith(`${tag}/`);
  if (!existsSync("/proc/self/environ")) {
    const ps = spawnSync("ps", ["-AEww", "-o", "pid=,command="], { encoding: "utf8" }).stdout ?? "";
    return ps
      .split("\n")
      .filter((line) => line.split(" ").some(owned))
      .map((line) => Number.parseInt(line, 10));
  }
  return readdirSync("/proc")
    .map(Number)
    .filter((pid) => {
      if (!Number.isInteger(pid)) return false;
      try {
        return readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").some(owned);
      } catch {
        return false;
      }
    });
}

function killOwned(owner: string): void {
  for (let pass = 0; pass < 50; pass++) {
    const pids = ownedPids(owner);
    if (!pids.length) return;
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      }
    }
  }
  throw new Error(`fake-e2b: processes survived cleanup: ${ownedPids(owner).join(", ")}`);
}

interface E2bState {
  root: string;
  records: Map<string, FakeRecord>;
  snapshots: Map<string, string>;
  execScripts: string[];
  seq: { id: number; snapshot: number; clock: number };
  fake: FakeE2b;
}

const destroyRecord = (st: E2bState, r: FakeRecord): void => {
  r.expired = true;
  killOwned(`${st.root}/${r.sandboxId}`);
  rmSync(r.home, { recursive: true, force: true });
};

const byName = (st: E2bState, name: string): FakeRecord | undefined =>
  latestByName(
    st.records.values(),
    (r) => r.metadata.name === name,
    (r) => !r.expired,
  );

const hostPath = (r: FakeRecord, absPath: string): string => absPath.replace(/^\/home\/user/, r.home);

function alive(r: FakeRecord): void {
  if (r.expired) throw new E2bSandboxGoneError(r.sandboxId, "sandbox was not found");
  if (r.state === "paused") {
    if (!r.autoPause) throw new E2bSandboxGoneError(r.sandboxId, "sandbox is paused and cannot auto-resume");
    r.state = "running";
  }
}

function e2bSession(st: E2bState, r: FakeRecord): E2bSession {
  return {
    sandboxId: r.sandboxId,
    trafficAccessToken: `traffic-${r.sandboxId}`,
    host: (port) => `${port}-${r.sandboxId}.e2b.test`,
    async runCommand(command, opts): Promise<E2bCommandResult> {
      alive(r);
      if (opts?.timeoutMs) r.timeoutMs.push(opts.timeoutMs);
      if (r.loseNextCommand) {
        r.loseNextCommand = false;
        r.state = "paused";
        throw new E2bCommandLostError(r.sandboxId, "sandbox timeout");
      }
      st.execScripts.push(command);
      mkdirSync(join(r.home, "tmp"), { recursive: true });
      const script = remapScript(command, { home: r.home, guest: /\/home\/user/g });
      return textResult(runShell(script, { env: { [OWNER_ENV]: `${st.root}/${r.sandboxId}` } }));
    },
    async readFileBytes(absPath): Promise<Uint8Array | null> {
      alive(r);
      return readHostFile(hostPath(r, absPath));
    },
    async writeFileBytes(absPath, data): Promise<void> {
      alive(r);
      writeHostFile(hostPath(r, absPath), data);
    },
    async keepAlive(ms): Promise<void> {
      alive(r);
      r.timeoutMs.push(ms);
    },
    async pause(): Promise<void> {
      if (r.expired) throw new E2bSandboxGoneError(r.sandboxId, "sandbox was not found");
      r.state = "paused";
    },
    async createSnapshot(): Promise<{ snapshotId: string }> {
      alive(r);
      const snapshotId = `snap-${st.seq.snapshot++}`;
      const dir = join(st.root, "snapshots", snapshotId);
      mkdirSync(dirname(dir), { recursive: true });
      cpSync(r.home, dir, { recursive: true });
      st.snapshots.set(snapshotId, dir);
      return { snapshotId };
    },
    async metrics(): Promise<E2bMetrics | null> {
      alive(r);
      return st.fake.metrics;
    },
    async kill(): Promise<void> {
      destroyRecord(st, r);
    },
  };
}

function createRecord(st: E2bState, opts: Parameters<E2bClient["create"]>[0]): FakeRecord {
  const id = `sbx-${st.seq.id++}`;
  const r: FakeRecord = {
    sandboxId: id,
    state: "running",
    expired: false,
    autoPause: opts.autoPause ?? false,
    metadata: opts.metadata,
    home: join(st.root, id),
    createdAt: ++st.seq.clock,
    timeoutMs: [],
    ...(opts.timeoutMs ? { createTimeoutMs: opts.timeoutMs } : {}),
    loseNextCommand: false,
    autoResume: opts.autoResume ?? false,
    ...(opts.fromSnapshot ? { fromSnapshot: opts.fromSnapshot } : {}),
  };
  if (opts.fromSnapshot) {
    const dir = st.snapshots.get(opts.fromSnapshot);
    if (!dir) throw new Error(`fake-e2b: snapshot ${opts.fromSnapshot} not found`);
    cpSync(dir, r.home, { recursive: true });
  } else {
    mkdirSync(r.home, { recursive: true });
  }
  st.records.set(id, r);
  return r;
}

function e2bClient(st: E2bState, withInfo: boolean): E2bClient {
  const info: Pick<E2bClient, "info"> = withInfo
    ? {
        async info(sandboxId) {
          const r = st.records.get(sandboxId);
          if (!r || r.expired) throw new E2bSandboxGoneError(sandboxId, "sandbox was not found");
          return { state: r.state, expiresAtMs: Date.now() + 60_000 };
        },
      }
    : {};
  return {
    ...info,
    async create(opts): Promise<E2bSession> {
      return e2bSession(st, createRecord(st, opts));
    },
    async connect(sandboxId): Promise<E2bSession> {
      const r = st.records.get(sandboxId);
      if (!r || r.expired) throw new E2bSandboxGoneError(sandboxId, "sandbox was not found");
      r.state = "running";
      return e2bSession(st, r);
    },
    async list(metadata): Promise<Array<{ sandboxId: string; state: string; metadata?: Record<string, string> }>> {
      return [...st.records.values()]
        .filter((r) => !r.expired && Object.entries(metadata).every(([k, v]) => r.metadata[k] === v))
        .map((r) => ({ sandboxId: r.sandboxId, state: r.state, metadata: r.metadata }));
    },
    async kill(sandboxId): Promise<void> {
      const r = st.records.get(sandboxId);
      if (!r) return;
      destroyRecord(st, r);
    },
    async deleteSnapshot(snapshotId): Promise<void> {
      const dir = st.snapshots.get(snapshotId);
      if (!dir) return;
      rmSync(dir, { recursive: true, force: true });
      st.snapshots.delete(snapshotId);
    },
  };
}

function e2bControls(st: E2bState): FakeE2b {
  const need = (name: string): FakeRecord => {
    const r = byName(st, name);
    if (!r) throw new Error(`fake-e2b: no sandbox named ${name}`);
    return r;
  };
  return {
    client: null as unknown as E2bClient,
    metrics: null,
    current: (name) => {
      const r = byName(st, name);
      return r && !r.expired ? { sandboxId: r.sandboxId, state: r.state, metadata: r.metadata } : null;
    },
    createdCount: (name) => [...st.records.values()].filter((r) => r.metadata.name === name).length,
    homeDir: (name) => need(name).home,
    pause: (name) => {
      const r = byName(st, name);
      if (r) r.state = "paused";
    },
    expirePaused: () => {
      for (const r of st.records.values()) {
        if (r.state === "paused" && !r.expired) destroyRecord(st, r);
      }
    },
    loseNextCommand: (name) => {
      const r = byName(st, name);
      if (r) r.loseNextCommand = true;
    },
    timeouts: (name) => [...(byName(st, name)?.timeoutMs ?? [])],
    createOptions: (name) => {
      const r = need(name);
      return {
        autoPause: r.autoPause,
        autoResume: r.autoResume,
        ...(r.createTimeoutMs ? { timeoutMs: r.createTimeoutMs } : {}),
      };
    },
    snapshots: () => [...st.snapshots.keys()],
    restoredFrom: (name) => byName(st, name)?.fromSnapshot,
    execScripts: () => [...st.execScripts],
    cleanup: () => {
      killOwned(st.root);
      rmSync(st.root, { recursive: true, force: true });
    },
  };
}

export function installFakeE2b(fakeOpts: { info?: boolean } = {}): FakeE2b {
  const st: E2bState = {
    root: mkdtempSync(join(tmpdir(), "fake-e2b-")),
    records: new Map(),
    snapshots: new Map(),
    execScripts: [],
    seq: { id: 1, snapshot: 1, clock: 0 },
    fake: null as unknown as FakeE2b,
  };
  st.fake = e2bControls(st);
  st.fake.client = e2bClient(st, fakeOpts.info ?? false);
  return st.fake;
}
