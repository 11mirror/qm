import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NotFoundError } from "porter-sandbox";
import type { PorterClientLike, PorterSandboxLike, PorterSandboxSpec } from "../../src/deploy/porter-client.ts";
import { escapeRe } from "./fake-provider-kit.ts";

export interface FakePorterBody {
  name: string;
  phase: string;
  tags: Record<string, string>;
  host: string;
  egress?: string[];
  env?: Record<string, string>;
  networking?: PorterSandboxSpec["networking"];
}

export interface FakePorterOptions {
  terminateLag?: number;
  pageSize?: number;
  assignHost?: boolean;
}

export interface FakePorter {
  client: PorterClientLike;
  bodies(): FakePorterBody[];
  hostOf(name: string): string;
  statusReads(): number;
  volumeDir(volumeName: string): string;
  volumeNames(): string[];
  terminateAll(): void;
  execScripts(): string[];
  cleanup(): void;
}

const GUEST_HOME = "/root";
const GUEST_APP = "/app";
const PID_FILE = "qm-app.pid";

interface BodyRecord {
  id: string;
  phase: string;
  terminatingTicks: number;
  tags: Record<string, string>;
  home: string;
  app: string;
  tmp: string;
  mounts: Record<string, string>;
  host: string;
  egress?: string[];
  env?: Record<string, string>;
  networking?: PorterSandboxSpec["networking"];
}

const pathRe = (guestPath: string): RegExp => new RegExp(`${escapeRe(guestPath)}(?![A-Za-z0-9._-])`, "g");

interface PorterState {
  opts: FakePorterOptions;
  root: string;
  volumes: Map<string, { id: string; dir: string }>;
  bodies: Map<string, BodyRecord>;
  execScripts: string[];
  seq: { volume: number; body: number; statusReads: number };
}

function observe(b: BodyRecord | undefined): BodyRecord | undefined {
  if (b && b.phase === "terminating") {
    if (b.terminatingTicks > 0) b.terminatingTicks -= 1;
    if (b.terminatingTicks === 0) b.phase = "terminated";
  }
  return b;
}

const volumeById = (st: PorterState, id: string): { id: string; dir: string } | undefined =>
  [...st.volumes.values()].find((v) => v.id === id);

function bodyById(st: PorterState, id: string): BodyRecord {
  const found = [...st.bodies.values()].find((b) => b.id === id);
  if (!found) throw new NotFoundError(`fake porter: no sandbox ${id}`);
  return found;
}

const attachedTo = (st: PorterState, dir: string): BodyRecord | undefined =>
  [...st.bodies.values()].find((b) => b.phase !== "terminated" && Object.values(b.mounts).includes(dir));

function remap(b: BodyRecord, script: string): string {
  const remapTmp = new RegExp(`${escapeRe(GUEST_HOME)}/tmp/|/tmp/`, "g");
  let out = script
    .replace(/\btimeout (?:-k \d+ )?\d+ /g, "")
    .replace(remapTmp, `${b.tmp}/`)
    .replace(pathRe(GUEST_HOME), b.home)
    .replace(pathRe(GUEST_APP), b.app);
  for (const [guest, dir] of Object.entries(b.mounts)) if (guest !== GUEST_HOME) out = out.replace(pathRe(guest), dir);
  return `export HOME=${JSON.stringify(b.home)}; ${out}`;
}

function killApp(b: BodyRecord): void {
  const pidFile = join(b.tmp, PID_FILE);
  if (!existsSync(pidFile)) return;
  const pid = readFileSync(pidFile, "utf8").trim();
  if (!/^\d+$/.test(pid)) return;
  spawnSync("sh", [
    "-c",
    `kill -TERM -${pid} 2>/dev/null; pkill -TERM -P ${pid} 2>/dev/null; kill -TERM ${pid} 2>/dev/null; true`,
  ]);
}

function retire(st: PorterState, b: BodyRecord): void {
  if (b.phase === "terminated" || b.phase === "terminating") return;
  killApp(b);
  rmSync(b.tmp, { recursive: true, force: true });
  rmSync(b.app, { recursive: true, force: true });
  if (!volumeById(st, b.tags["qm-volume-id"] ?? "")) rmSync(b.home, { recursive: true, force: true });
  if ((st.opts.terminateLag ?? 0) > 0) {
    b.phase = "terminating";
    b.terminatingTicks = st.opts.terminateLag ?? 0;
  } else {
    b.phase = "terminated";
  }
}

function sandboxOf(st: PorterState, name: string, statusKnown = true): PorterSandboxLike {
  let known = statusKnown;
  return {
    id: st.bodies.get(name)!.id,
    get phase() {
      return known ? (st.bodies.get(name)?.phase ?? "terminated") : null;
    },
    get tags() {
      return st.bodies.get(name)?.tags ?? null;
    },
    async refresh() {
      known = true;
      const cur = observe(st.bodies.get(name));
      const internal = cur?.networking?.[0]?.internal ? cur.networking[0].port : undefined;
      return { name, host: cur?.host ?? "", ...(internal ? { internal_address: `127.0.0.1:${internal}` } : {}) };
    },
    async terminate() {
      const cur = st.bodies.get(name);
      if (cur) retire(st, cur);
    },
  };
}

function mountVolumes(st: PorterState, spec: PorterSandboxSpec): Record<string, string> {
  const mounts: Record<string, string> = {};
  for (const [guest, volId] of Object.entries(spec.volume_mounts ?? {})) {
    const vol = volumeById(st, volId);
    if (!vol) throw new Error(`fake porter: unknown volume ${volId}`);
    const holder = attachedTo(st, vol.dir);
    if (holder) throw new Error(`fake porter: volume ${volId} is still attached to a ${holder.phase} sandbox`);
    mounts[guest] = vol.dir;
  }
  return mounts;
}

function createBody(st: PorterState, spec: PorterSandboxSpec): PorterSandboxLike {
  if (st.bodies.has(spec.name!)) throw new Error("could not create sandbox: sandbox not running");
  const wanted = spec.networking?.[0]?.domains?.[0]?.domain;
  if (wanted && [...st.bodies.values()].some((b) => b.phase !== "terminated" && b.host === wanted)) {
    throw new Error(`fake porter: domain ${wanted} is held by a live sandbox`);
  }
  const mounts = mountVolumes(st, spec);
  const homeVolumeId = spec.volume_mounts?.[GUEST_HOME];
  const home = mounts[GUEST_HOME] ?? join(st.root, `${spec.name}-home`);
  const app = join(st.root, `${spec.name}-app`);
  mkdirSync(home, { recursive: true });
  mkdirSync(app, { recursive: true });
  const exposed = spec.networking?.[0];
  const named = st.opts.assignHost === false ? undefined : `${spec.name}.fake.test`;
  const host = exposed && !exposed.internal ? (exposed.domains?.[0]?.domain ?? named ?? "") : "";
  st.bodies.set(spec.name!, {
    id: `sb-${++st.seq.body}`,
    phase: "running",
    terminatingTicks: 0,
    tags: { ...spec.tags, ...(homeVolumeId ? { "qm-volume-id": homeVolumeId } : {}) },
    home,
    app,
    tmp: join(st.root, `${spec.name}-tmp`),
    mounts,
    host,
    ...(spec.egress ? { egress: spec.egress.allowed_destinations } : {}),
    ...(spec.env ? { env: spec.env } : {}),
    ...(spec.networking ? { networking: spec.networking } : {}),
  });
  return sandboxOf(st, spec.name!, false);
}

async function execBody(st: PorterState, id: string, command: string[]) {
  const cur = bodyById(st, id);
  if (cur.phase !== "running") throw new Error(`fake porter: exec on ${cur.phase} body`);
  const script = command[command.length - 1] ?? "";
  st.execScripts.push(script);
  mkdirSync(cur.tmp, { recursive: true });
  const child = spawn("sh", ["-c", remap(cur, script)], {
    env: { ...process.env, ...cur.env, COPYFILE_DISABLE: "1" },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const [code, sig] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (c, s) => resolve([c, s]));
  });
  return {
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    exit_code: code ?? (sig ? 137 : -1),
  };
}

function sandboxesApi(st: PorterState): PorterClientLike["sandboxes"] {
  return {
    async create(spec) {
      return createBody(st, spec);
    },
    async get(name) {
      if (!st.bodies.has(name)) throw new NotFoundError(`fake porter: no body ${name}`);
      return sandboxOf(st, name);
    },
    async list(options) {
      const tags = options?.tags ?? {};
      for (const b of st.bodies.values()) observe(b);
      const matching = [...st.bodies.keys()].filter((name) =>
        Object.entries(tags).every(([k, v]) => st.bodies.get(name)!.tags[k] === v),
      );
      const pageSize = st.opts.pageSize ?? matching.length;
      const page = options?.page ?? 1;
      return matching.slice((page - 1) * pageSize, page * pageSize).map((name) => sandboxOf(st, name));
    },
    raw: {
      async get(id) {
        st.seq.statusReads += 1;
        const cur = bodyById(st, id);
        observe(cur);
        return { phase: cur.phase, host: cur.host };
      },
      async exec(id, body, _options) {
        return execBody(st, id, body.command);
      },
    },
  };
}

function volumesApi(st: PorterState): PorterClientLike["volumes"] {
  return {
    async create(body) {
      const name = body.name ?? `vol-anon-${++st.seq.volume}`;
      let v = st.volumes.get(name);
      if (!v) {
        v = { id: `vol-${++st.seq.volume}`, dir: join(st.root, `vol-${name}`) };
        mkdirSync(v.dir, { recursive: true });
        st.volumes.set(name, v);
      }
      return { id: v.id };
    },
    async get(name) {
      const v = st.volumes.get(name);
      if (!v) throw new NotFoundError(`fake porter: no volume ${name}`);
      return { id: v.id };
    },
    async delete(name) {
      const v = st.volumes.get(name);
      if (!v) return;
      if (attachedTo(st, v.dir)) throw new Error("volume is attached to a sandbox");
      rmSync(v.dir, { recursive: true, force: true });
      st.volumes.delete(name);
    },
    raw: {
      async writeFile(id, body, options) {
        const v = volumeById(st, id);
        if (!v) throw new NotFoundError(`fake porter: no volume ${id}`);
        const target = join(v.dir, options.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, body);
      },
    },
  };
}

export function installFakePorter(opts: FakePorterOptions = {}): FakePorter {
  const st: PorterState = {
    opts,
    root: mkdtempSync(join(tmpdir(), "fake-porter-")),
    volumes: new Map(),
    bodies: new Map(),
    execScripts: [],
    seq: { volume: 0, body: 0, statusReads: 0 },
  };
  return {
    client: { sandboxes: sandboxesApi(st), volumes: volumesApi(st) },
    bodies: () =>
      [...st.bodies.entries()].map(([name, b]) => ({
        name,
        phase: b.phase,
        tags: b.tags,
        host: b.host,
        ...(b.egress ? { egress: b.egress } : {}),
        ...(b.env ? { env: b.env } : {}),
        ...(b.networking ? { networking: b.networking } : {}),
      })),
    hostOf: (name) => st.bodies.get(name)?.host ?? "",
    statusReads: () => st.seq.statusReads,
    volumeDir: (volumeName) => {
      const v = st.volumes.get(volumeName);
      if (!v || !existsSync(v.dir)) throw new Error(`fake porter: no volume ${volumeName}`);
      return v.dir;
    },
    volumeNames: () => [...st.volumes.keys()],
    terminateAll: () => {
      for (const [, b] of st.bodies) retire(st, b);
    },
    execScripts: () => st.execScripts,
    cleanup: () => {
      for (const [, b] of st.bodies) killApp(b);
      rmSync(st.root, { recursive: true, force: true });
    },
  };
}
