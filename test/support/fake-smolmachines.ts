import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHostFile, remapScript, runShell, toBuf, writeHostFile } from "./fake-provider-kit.ts";

export interface SmolCall {
  method: string;
  path: string;
  query?: string;
  body?: unknown;
  script?: string;
}

export interface FakeMachineView {
  state: string;
  ready: boolean;
  error?: string;
  ephemeral: boolean;
  resources?: Record<string, number>;
  network: unknown;
  ttlSeconds?: number;
  autoStopSeconds?: number;
}

interface FakeMachine {
  id: string;
  name: string | null;
  state: string;
  error?: string;
  notReadyGets: number;
  ephemeral: boolean;
  resources?: Record<string, number>;
  network: unknown;
  ttlSeconds?: number;
  autoStopSeconds?: number;
  home: string;
}

export interface InjectedFailure {
  headers?: Record<string, string>;
  match?: (call: { method: string; path: string }) => boolean;
}

interface CreateBody {
  name?: string | null;
  ephemeral?: boolean;
  resources?: Record<string, number>;
  network?: unknown;
  ttlSeconds?: number;
  autoStopSeconds?: number;
}

export interface FakeSmolmachines {
  fetchImpl: typeof fetch;
  calls: SmolCall[];
  homeDir(name: string): string;
  names(): string[];
  machine(name: string): FakeMachineView | null;
  stop(name: string): void;
  failNext(status: number, opts?: InjectedFailure): void;
  fail(name: string, reason: string): void;
  notReadyFor(name: string, gets: number): void;
  deleteBehindCore(name: string): void;
  execScripts(): string[];
  reset(): void;
  cleanup(): void;
}

export const FAKE_SMOLMACHINES_TOKEN = "test-token";

interface SmolState {
  root: string;
  machines: Map<string, FakeMachine>;
  execScripts: string[];
  calls: SmolCall[];
  injected: Array<InjectedFailure & { status: number }>;
  seq: { id: number };
}

const byName = (st: SmolState, name: string): FakeMachine | undefined =>
  [...st.machines.values()].find((m) => m.name === name);

function createMachine(st: SmolState, body: CreateBody): FakeMachine {
  const id = `m-${st.seq.id++}`;
  const m: FakeMachine = {
    id,
    name: body.name ?? null,
    state: "stopped",
    notReadyGets: 0,
    ephemeral: body.ephemeral ?? false,
    ...(body.resources ? { resources: body.resources } : {}),
    network: body.network ?? { mode: "open" },
    ...(body.ttlSeconds !== undefined ? { ttlSeconds: body.ttlSeconds } : {}),
    ...(body.autoStopSeconds !== undefined ? { autoStopSeconds: body.autoStopSeconds } : {}),
    home: join(st.root, id),
  };
  mkdirSync(m.home, { recursive: true });
  st.machines.set(id, m);
  return m;
}

function runExec(st: SmolState, m: FakeMachine, script: string, output: string | null): Response {
  st.execScripts.push(script);
  mkdirSync(join(m.home, "tmp"), { recursive: true });
  const { stdout, stderr, code } = runShell(remapScript(script, { home: m.home, guest: /\/root/g }));
  const cap = 1024 * 1024;
  const text = output !== "b64";
  const bytes = output !== "text";
  return Response.json({
    stdout: text ? stdout.toString("utf8").slice(0, cap) : "",
    stderr: text ? stderr.toString("utf8").slice(0, cap) : "",
    exitCode: code,
    durationMs: 1,
    machineId: m.id,
    stdoutTruncated: text && stdout.length > cap,
    stderrTruncated: text && stderr.length > cap,
    ...(bytes ? { stdoutB64: stdout.toString("base64"), stderrB64: stderr.toString("base64") } : {}),
  });
}

const ready = (m: FakeMachine): boolean => m.state.toLowerCase() === "running" && m.notReadyGets <= 0;

const info = (m: FakeMachine) => ({
  id: m.id,
  name: m.name,
  state: m.state,
  ready: ready(m),
  error: m.error ?? null,
  ephemeral: m.ephemeral,
  source: { type: "image", reference: "ubuntu:24.04" },
  resources: m.resources ?? {},
  network: m.network,
  ttlSeconds: m.ttlSeconds ?? null,
  autoStopSeconds: m.autoStopSeconds ?? null,
  env: {},
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

function handleFiles(st: SmolState, files: RegExpExecArray, method: string, init?: RequestInit): Response | null {
  const m = st.machines.get(decodeURIComponent(files[1]!));
  if (!m) return new Response("machine not found", { status: 404 });
  const abs = files[2]!.split("/").map(decodeURIComponent).join("/");
  if (abs.startsWith("/tmp/")) return new Response("file not found", { status: 404 });
  const hostPath = abs.replace(/^\/root/, m.home);
  if (method === "PUT") {
    m.state = "Running";
    const data = toBuf(init?.body);
    writeHostFile(hostPath, data);
    return Response.json({ path: abs, size: data.length });
  }
  if (method === "GET") {
    const bytes = readHostFile(hostPath);
    return bytes ? new Response(bytes, { status: 200 }) : new Response("file not found", { status: 404 });
  }
  return null;
}

function handleMachine(
  st: SmolState,
  sub: RegExpExecArray,
  url: URL,
  call: SmolCall,
  init?: RequestInit,
): Response | null {
  const m = st.machines.get(decodeURIComponent(sub[1]!));
  if (!m) return new Response("machine not found", { status: 404 });
  if (sub[2] === "exec") {
    if (m.state.toLowerCase() !== "running") return new Response("machine is stopped", { status: 409 });
    const body = JSON.parse(toBuf(init?.body).toString() || "{}") as { command?: string[] | string };
    call.body = body;
    const argv = Array.isArray(body.command) ? body.command : ["sh", "-c", body.command ?? ""];
    const script = argv[argv.length - 1] ?? "";
    call.script = script;
    return runExec(st, m, script, url.searchParams.get("output"));
  }
  if (sub[2] === "start") {
    if (m.error) return new Response(`machine failed: ${m.error}`, { status: 409 });
    m.state = "Running";
    return Response.json(info(m));
  }
  if (sub[2] === "stop") {
    m.state = "stopped";
    return Response.json(info(m));
  }
  if (call.method === "GET") {
    const body = info(m);
    m.notReadyGets--;
    return Response.json(body);
  }
  if (call.method === "DELETE") {
    rmSync(m.home, { recursive: true, force: true });
    st.machines.delete(m.id);
    return new Response(null, { status: 204 });
  }
  return null;
}

function smolFetch(st: SmolState): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    const call: SmolCall = { method, path: url.pathname, ...(url.search ? { query: url.search.slice(1) } : {}) };
    st.calls.push(call);
    const at = st.injected.findIndex((f) => !f.match || f.match({ method, path: url.pathname }));
    if (at >= 0) {
      const [next] = st.injected.splice(at, 1);
      return new Response(`injected ${next!.status}`, { status: next!.status, headers: next!.headers ?? {} });
    }
    if (url.pathname === "/v1/machines" && method === "GET") {
      return Response.json([...st.machines.values()].map(info));
    }
    if (url.pathname === "/v1/machines" && method === "POST") {
      const body = JSON.parse(toBuf(init?.body).toString() || "{}") as CreateBody;
      call.body = body;
      if (body.name && byName(st, body.name)) return new Response("machine name conflict", { status: 409 });
      return Response.json(info(createMachine(st, body)), { status: 201 });
    }
    const files = /^\/v1\/machines\/([^/]+)\/files(\/.+)$/.exec(url.pathname);
    const filesResponse = files ? handleFiles(st, files, method, init) : null;
    if (filesResponse) return filesResponse;
    const sub = /^\/v1\/machines\/([^/]+)(?:\/(exec|start|stop))?$/.exec(url.pathname);
    const machineResponse = sub ? handleMachine(st, sub, url, call, init) : null;
    return machineResponse ?? new Response("not found", { status: 404 });
  };
}

function machineView(m: FakeMachine): FakeMachineView {
  return {
    state: m.state,
    ready: ready(m),
    ...(m.error ? { error: m.error } : {}),
    ephemeral: m.ephemeral,
    ...(m.resources ? { resources: m.resources } : {}),
    network: m.network,
    ...(m.ttlSeconds !== undefined ? { ttlSeconds: m.ttlSeconds } : {}),
    ...(m.autoStopSeconds !== undefined ? { autoStopSeconds: m.autoStopSeconds } : {}),
  };
}

export function installFakeSmolmachines(): FakeSmolmachines {
  const st: SmolState = {
    root: mkdtempSync(join(tmpdir(), "fake-smol-")),
    machines: new Map(),
    execScripts: [],
    calls: [],
    injected: [],
    seq: { id: 1 },
  };
  const named = (name: string, act: (m: FakeMachine) => void): void => {
    const m = byName(st, name);
    if (m) act(m);
  };
  return {
    fetchImpl: smolFetch(st),
    calls: st.calls,
    homeDir: (name) => (byName(st, name) ?? createMachine(st, { name })).home,
    names: () => [...st.machines.values()].map((m) => m.name ?? m.id),
    machine: (name) => {
      const m = byName(st, name);
      return m ? machineView(m) : null;
    },
    stop: (name) => named(name, (m) => (m.state = "stopped")),
    failNext: (status, opts = {}) => {
      st.injected.push({ status, ...opts });
    },
    fail: (name, reason) =>
      named(name, (m) => {
        m.state = "error";
        m.error = reason;
      }),
    notReadyFor: (name, gets) => named(name, (m) => (m.notReadyGets = gets)),
    deleteBehindCore: (name) =>
      named(name, (m) => {
        rmSync(m.home, { recursive: true, force: true });
        st.machines.delete(m.id);
      }),
    execScripts: () => [...st.execScripts],
    reset: () => {
      for (const m of st.machines.values()) rmSync(m.home, { recursive: true, force: true });
      st.machines.clear();
      st.execScripts.length = 0;
      st.calls.length = 0;
      st.injected.length = 0;
    },
    cleanup: () => rmSync(st.root, { recursive: true, force: true }),
  };
}
