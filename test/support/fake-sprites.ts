import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SCRIPT_RUNNER } from "../../src/sandbox/sprites-sandbox.ts";
import { remapScript, runShell, toBuf } from "./fake-provider-kit.ts";

export interface NetworkRule {
  domain: string;
  action: string;
}

export interface SpritesCall {
  method: string;
  path: string;
  script?: string;
}

export interface InjectedFailure {
  headers?: Record<string, string>;
  match?: (call: { method: string; path: string }) => boolean;
}

export interface FakeSprites {
  baseUrl: string;
  calls: SpritesCall[];
  homeDir(name: string): string;
  names(): string[];
  policy(name: string): NetworkRule[] | null;
  resources(name: string): { limitMB: number } | null;
  checkpoints(name: string): string[];
  execScripts(): string[];
  stallAfterRun(name: string): void;
  fail502(name: string): void;
  failNext(status: number, opts?: InjectedFailure): void;
  refuseRestart(name: string): void;
  unhealthy(name: string, reason: string): void;
  health(name: string, status: string, reason: string): void;
  refuseDelete(status?: number): void;
  rateLimitCreate(retryAfterSeconds: number): void;
  breakPolicyReadback(name: string): void;
  setPressure(name: string, p: { full10: number; full60: number; load1: number }): void;
  restarts(): string[];
  reset(): void;
  cleanup(): void;
}

const TOKEN = "test-token";
const API_ORIGIN = "https://api.sprites.dev";
const GUEST_HOME = "/home/sprite";

interface Engine {
  fetch(url: URL, init?: RequestInit): Promise<Response>;
  exec(url: URL): FakeExec | null;
}

interface FakeExec {
  run(stdin: Buffer): { frames: Buffer[]; dropAfterRun: boolean };
  refused: boolean;
}

const engines = new Map<string, Engine>();
let nextOrigin = 0;
let routerInstalled = false;

const toArrayBuffer = (buf: Buffer): ArrayBuffer =>
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  binaryType = "blob";
  private readonly stdin: Buffer[] = [];
  private closed = false;

  private readonly exec: FakeExec;

  constructor(url: string, exec: FakeExec) {
    super();
    void url;
    this.exec = exec;
    setImmediate(() => {
      if (this.closed) return;
      if (exec.refused) {
        this.fail("Received network error or non-101 status code.");
        return;
      }
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(data: Buffer | string): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("fake websocket is not open");
    if (typeof data === "string") return;
    const frame = Buffer.from(data);
    if (frame[0] === 0) this.stdin.push(frame.subarray(1));
    if (frame[0] !== 4) return;
    const { frames, dropAfterRun } = this.exec.run(Buffer.concat(this.stdin));
    setImmediate(() => {
      if (this.closed) return;
      if (dropAfterRun) {
        this.fail("connection reset by peer");
        return;
      }
      for (const f of frames) this.dispatchEvent(new MessageEvent("message", { data: toArrayBuffer(f) }));
      this.finish(1000, "");
    });
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.readyState = FakeWebSocket.CLOSING;
    setImmediate(() => this.finish(code, reason));
  }

  private fail(message: string): void {
    this.dispatchEvent(Object.assign(new Event("error"), { message, error: new Error(message) }));
    this.finish(1006, "");
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
  }
}

function installRouter(): void {
  if (routerInstalled) return;
  routerInstalled = true;
  const realFetch = globalThis.fetch;
  const RealWebSocket = globalThis.WebSocket;
  const patchedFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const engine = engines.get(url.origin);
    return engine ? engine.fetch(url, init) : realFetch(input, init);
  };
  (globalThis as { fetch: typeof fetch }).fetch = patchedFetch;
  const Patched = function (this: unknown, url: string | URL, options?: unknown) {
    const parsed = new URL(String(url));
    const origin = parsed.origin.replace(/^ws/, "http");
    const exec = engines.get(origin)?.exec(parsed);
    if (exec) return new FakeWebSocket(parsed.href, exec);
    return new RealWebSocket(url, options as never);
  } as unknown as typeof WebSocket;
  Object.assign(Patched, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  (globalThis as { WebSocket: typeof WebSocket }).WebSocket = Patched;
}

interface SpritesState {
  root: string;
  sprites: Map<string, { home: string }>;
  policies: Map<string, NetworkRule[]>;
  resources: Map<string, { limitMB: number }>;
  checkpoints: Map<string, Array<{ id: string; createTime: string; dir: string }>>;
  execScripts: string[];
  calls: SpritesCall[];
  gateway502: Set<string>;
  stallAfterRun: Set<string>;
  refusedRestart: Set<string>;
  unhealthy: Map<string, string>;
  health: Map<string, { status: string; reason: string }>;
  brokenReadback: Set<string>;
  restarts: string[];
  injected: Array<InjectedFailure & { status: number }>;
  knobs: { refuseDeleteStatus?: number; rateLimitRetryAfter?: number; checkpointSeq: number };
}

function ensureDir(st: SpritesState, name: string): string {
  let s = st.sprites.get(name);
  if (!s) {
    s = { home: join(st.root, name) };
    mkdirSync(s.home, { recursive: true });
    st.sprites.set(name, s);
  }
  return s.home;
}

function hostPath(st: SpritesState, name: string, abs: string): string {
  const home = ensureDir(st, name);
  if (abs.startsWith(`${st.root}/`)) return abs;
  if (abs === GUEST_HOME || abs.startsWith(`${GUEST_HOME}/`)) return home + abs.slice(GUEST_HOME.length);
  if (abs.startsWith("/tmp/")) return join(home, "tmp", abs.slice(5));
  if (abs.startsWith("/usr/local/")) return join(home, ".usr-local", abs.slice("/usr/local/".length));
  return join(home, abs);
}

function remap(st: SpritesState, name: string, script: string): string {
  const home = ensureDir(st, name);
  return remapScript(script, {
    home,
    guest: /\/home\/sprite/g,
    rewrites: [
      [/\bsha256sum -c --status\b/g, "shasum -a 256 -c --status"],
      [/\/proc\/pressure\/io/g, `${home}/.proc-pressure-io`],
      [/\/proc\/loadavg/g, `${home}/.proc-loadavg`],
      [/\/usr\/local/g, `${home}/.usr-local`],
    ],
  });
}

function runExec(st: SpritesState, name: string, argv: string[], stdin: Buffer): Buffer[] {
  mkdirSync(join(ensureDir(st, name), "tmp"), { recursive: true });
  const viaBody = argv[argv.length - 1] === SCRIPT_RUNNER;
  const script = viaBody ? stdin.toString("utf8") : (argv[argv.length - 1] ?? "");
  st.execScripts.push(script);
  const r = viaBody
    ? runShell(SCRIPT_RUNNER, { input: Buffer.from(remap(st, name, script), "utf8") })
    : runShell(remap(st, name, script), { input: stdin });
  const frame = (id: number, payload: Buffer): Buffer => Buffer.concat([Buffer.from([id]), payload]);
  return [frame(1, r.stdout), frame(2, r.stderr), Buffer.from([3, r.code & 0xff])];
}

function deleteSprite(st: SpritesState, name: string): void {
  const s = st.sprites.get(name);
  if (s) rmSync(s.home, { recursive: true, force: true });
  for (const cp of st.checkpoints.get(name) ?? []) rmSync(cp.dir, { recursive: true, force: true });
  st.sprites.delete(name);
  st.policies.delete(name);
  st.resources.delete(name);
  st.checkpoints.delete(name);
}

const ndjson = (lines: object[]): Response =>
  new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });

function fsResult(path: string, op: () => object): Response {
  try {
    return Response.json(op());
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return Response.json({ error: err.message ?? "filesystem error", code: err.code, path }, { status: 500 });
  }
}

const notFound = (what: string): Response =>
  Response.json({ error: "not_found", message: `${what} not found` }, { status: 404 });

const jsonBody = <T>(init?: RequestInit): T => JSON.parse(toBuf(init?.body).toString() || "{}") as T;

function createSprite(st: SpritesState, init?: RequestInit): Response {
  if (st.knobs.rateLimitRetryAfter !== undefined) {
    const retry = st.knobs.rateLimitRetryAfter;
    st.knobs.rateLimitRetryAfter = undefined;
    return Response.json(
      {
        error: "sprite_creation_rate_limited",
        message: "Sprite creation rate limit exceeded",
        limit: 10,
        window_seconds: 60,
        retry_after_seconds: retry,
      },
      { status: 429, headers: { "retry-after": String(retry) } },
    );
  }
  const name = jsonBody<{ name?: string }>(init).name ?? "unnamed";
  ensureDir(st, name);
  return Response.json({ name, status: "running" });
}

function spriteRoot(st: SpritesState, name: string, method: string): Response {
  if (method === "GET") return st.sprites.has(name) ? Response.json({ name, status: "warm" }) : notFound("sprite");
  if (method === "DELETE") {
    if (st.knobs.refuseDeleteStatus !== undefined)
      return Response.json({ error: "upstream" }, { status: st.knobs.refuseDeleteStatus });
    if (!st.sprites.has(name)) return notFound("sprite");
    deleteSprite(st, name);
    return new Response(null, { status: 204 });
  }
  return notFound("route");
}

function lifecycleRoute(st: SpritesState, name: string, sub: string, method: string): Response | null {
  if (sub === "check") {
    const reason = st.unhealthy.get(name);
    return Response.json({
      sprite_name: name,
      sprite_id: `id-${name}`,
      status: st.health.get(name)?.status ?? (reason ? "unhealthy" : "healthy"),
      reason: st.health.get(name)?.reason ?? reason ?? null,
      checked_at: new Date().toISOString(),
      elapsed: 0.01,
    });
  }
  if (sub === "restart" && method === "POST") {
    if (st.refusedRestart.has(name)) return Response.json({ error: "upstream restart failed" }, { status: 502 });
    st.restarts.push(name);
    st.gateway502.delete(name);
    return Response.json({ sprite_name: name, machine_id: "m1", message: "queued" }, { status: 202 });
  }
  return null;
}

function policyRoute(st: SpritesState, name: string, sub: string, method: string, init?: RequestInit): Response | null {
  if (sub === "policy/network") {
    if (method === "GET")
      return Response.json({ rules: st.brokenReadback.has(name) ? [] : (st.policies.get(name) ?? []) });
    st.policies.set(name, jsonBody<{ rules?: NetworkRule[] }>(init).rules ?? []);
    return new Response(null, { status: 204 });
  }
  if (sub === "policy/resources") {
    if (method === "GET") {
      const r = st.resources.get(name);
      return Response.json({ memory: r ? { limit_mb: r.limitMB } : undefined });
    }
    if (method === "DELETE") {
      st.resources.delete(name);
      return new Response(null, { status: 204 });
    }
    const parsed = jsonBody<{ memory?: { limit_mb?: number } }>(init);
    if (parsed.memory?.limit_mb !== undefined) st.resources.set(name, { limitMB: parsed.memory.limit_mb });
    return new Response(null, { status: 204 });
  }
  return null;
}

function checkpointRoute(st: SpritesState, name: string, sub: string, method: string): Response | null {
  if (sub === "checkpoint" && method === "POST") {
    const id = `v${++st.knobs.checkpointSeq}`;
    const dir = join(st.root, ".checkpoints", name, id);
    cpSync(ensureDir(st, name), dir, { recursive: true });
    const list = st.checkpoints.get(name) ?? [];
    list.push({ id, createTime: new Date(Date.now() + list.length).toISOString(), dir });
    st.checkpoints.set(name, list);
    return ndjson([
      { type: "info", data: `checkpoint ${id}` },
      { type: "complete", data: id },
    ]);
  }
  if (sub === "checkpoints" && method === "GET") {
    return Response.json([
      { id: "Current", create_time: new Date().toISOString() },
      ...(st.checkpoints.get(name) ?? []).map((c) => ({ id: c.id, create_time: c.createTime, comment: "qm turn end" })),
    ]);
  }
  const restore = /^checkpoints\/([^/]+)\/restore$/.exec(sub);
  if (restore && method === "POST") {
    const cp = (st.checkpoints.get(name) ?? []).find((c) => c.id === decodeURIComponent(restore[1]!));
    if (!cp) return notFound("checkpoint");
    const home = ensureDir(st, name);
    rmSync(home, { recursive: true, force: true });
    cpSync(cp.dir, home, { recursive: true });
    st.gateway502.delete(name);
    return ndjson([
      { type: "info", data: `restoring ${cp.id}` },
      { type: "complete", data: cp.id },
    ]);
  }
  return null;
}

function fsRoute(st: SpritesState, name: string, sub: string, url: URL, init?: RequestInit): Response | null {
  const method = init?.method ?? "GET";
  if (sub === "fs/read" && method === "GET") {
    const target = hostPath(st, name, url.searchParams.get("path") ?? "");
    if (!existsSync(target)) return Response.json({ error: "no such file", path: target }, { status: 404 });
    return new Response(readFileSync(target), { status: 200 });
  }
  if (sub === "fs/write" && method === "PUT") {
    const target = hostPath(st, name, url.searchParams.get("path") ?? "");
    const data = toBuf(init?.body);
    const mode = url.searchParams.get("mode");
    return fsResult(target, () => {
      if (url.searchParams.get("mkdirParents") === "true") mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data);
      if (mode) chmodSync(target, Number.parseInt(mode, 8));
      return { path: target, size: data.length, mode: mode ?? "0644" };
    });
  }
  if (sub === "fs/rename" && method === "POST") {
    const body = jsonBody<{ source?: string; dest?: string }>(init);
    return fsResult(body.source ?? "", () => {
      renameSync(hostPath(st, name, body.source ?? ""), hostPath(st, name, body.dest ?? ""));
      return { source: body.source, dest: body.dest };
    });
  }
  return null;
}

function injectedFailure(st: SpritesState, method: string, path: string): Response | null {
  const at = st.injected.findIndex((f) => !f.match || f.match({ method, path }));
  if (at < 0) return null;
  const [next] = st.injected.splice(at, 1);
  return Response.json(
    { error: "injected", message: `injected ${next!.status}` },
    { status: next!.status, headers: next!.headers },
  );
}

function spritesFetch(st: SpritesState): Engine["fetch"] {
  return async (url, init) => {
    const method = init?.method ?? "GET";
    st.calls.push({ method, path: url.pathname + url.search });
    const failure = injectedFailure(st, method, url.pathname);
    if (failure) return failure;
    if (url.pathname === "/v1/sprites" && method === "POST") return createSprite(st, init);
    const one = /^\/v1\/sprites\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (!one) return notFound("route");
    const name = decodeURIComponent(one[1]!);
    const sub = one[2] ?? "";
    if (!sub) return spriteRoot(st, name, method);
    if (!st.sprites.has(name)) return notFound("sprite");
    return (
      lifecycleRoute(st, name, sub, method) ??
      policyRoute(st, name, sub, method, init) ??
      checkpointRoute(st, name, sub, method) ??
      fsRoute(st, name, sub, url, init) ??
      notFound("route")
    );
  };
}

function spritesExec(st: SpritesState): Engine["exec"] {
  return (url) => {
    const m = /^\/v1\/sprites\/([^/]+)\/exec$/.exec(url.pathname);
    if (!m) return null;
    const name = decodeURIComponent(m[1]!);
    const argv = url.searchParams.getAll("cmd");
    st.calls.push({ method: "WS", path: url.pathname });
    const call = st.calls[st.calls.length - 1]!;
    return {
      refused: !st.sprites.has(name) || st.gateway502.has(name),
      run: (stdin) => {
        const frames = runExec(st, name, argv, stdin);
        call.script = st.execScripts[st.execScripts.length - 1];
        const dropAfterRun = st.stallAfterRun.delete(name);
        return { frames, dropAfterRun };
      },
    };
  };
}

function resetSprites(st: SpritesState): void {
  for (const name of Array.from(st.sprites.keys())) deleteSprite(st, name);
  st.execScripts.length = 0;
  st.calls.length = 0;
  st.restarts.length = 0;
  st.injected.length = 0;
  for (const set of [st.stallAfterRun, st.gateway502, st.refusedRestart, st.brokenReadback]) set.clear();
  st.unhealthy.clear();
  st.health.clear();
  st.knobs.refuseDeleteStatus = undefined;
  st.knobs.rateLimitRetryAfter = undefined;
}

function writePressure(home: string, p: { full10: number; full60: number; load1: number }): void {
  writeFileSync(
    join(home, ".proc-pressure-io"),
    `some avg10=${p.full10} avg60=${p.full60} avg300=0.00 total=0\nfull avg10=${p.full10} avg60=${p.full60} avg300=0.00 total=0\n`,
  );
  writeFileSync(join(home, ".proc-loadavg"), `${p.load1} 0.00 0.00 1/100 1\n`);
}

export function installFakeSprites(origin = `https://fake-sprites-${++nextOrigin}.invalid`): FakeSprites {
  installRouter();
  const st: SpritesState = {
    root: mkdtempSync(join(tmpdir(), "fake-sprites-")),
    sprites: new Map(),
    policies: new Map(),
    resources: new Map(),
    checkpoints: new Map(),
    execScripts: [],
    calls: [],
    gateway502: new Set(),
    stallAfterRun: new Set(),
    refusedRestart: new Set(),
    unhealthy: new Map(),
    health: new Map(),
    brokenReadback: new Set(),
    restarts: [],
    injected: [],
    knobs: { checkpointSeq: 0 },
  };
  engines.set(origin, { fetch: spritesFetch(st), exec: spritesExec(st) });
  return {
    baseUrl: origin,
    calls: st.calls,
    homeDir: (name) => ensureDir(st, name),
    names: () => [...st.sprites.keys()],
    policy: (name) => st.policies.get(name) ?? null,
    resources: (name) => st.resources.get(name) ?? null,
    checkpoints: (name) => (st.checkpoints.get(name) ?? []).map((c) => c.id),
    execScripts: () => [...st.execScripts],
    stallAfterRun: (name) => void st.stallAfterRun.add(name),
    fail502: (name) => void st.gateway502.add(name),
    failNext: (status, opts = {}) => void st.injected.push({ status, ...opts }),
    refuseRestart: (name) => void st.refusedRestart.add(name),
    health: (name, status, reason) => void st.health.set(name, { status, reason }),
    unhealthy: (name, reason) => void st.unhealthy.set(name, reason),
    refuseDelete: (status) => {
      st.knobs.refuseDeleteStatus = status;
    },
    rateLimitCreate: (retryAfterSeconds) => {
      st.knobs.rateLimitRetryAfter = retryAfterSeconds;
    },
    breakPolicyReadback: (name) => void st.brokenReadback.add(name),
    setPressure: (name, p) => writePressure(ensureDir(st, name), p),
    restarts: () => [...st.restarts],
    reset: () => resetSprites(st),
    cleanup: () => {
      engines.delete(origin);
      rmSync(st.root, { recursive: true, force: true });
    },
  };
}

let globalFake: FakeSprites | null = null;

export function installGlobalFakeSprites(): FakeSprites {
  if (globalFake) return globalFake;
  globalFake = installFakeSprites(API_ORIGIN);
  return globalFake;
}

export const FAKE_SPRITES_TOKEN = TOKEN;
