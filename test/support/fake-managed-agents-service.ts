import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import * as loader from "@grpc/proto-loader";
import * as grpc from "@grpc/grpc-js";

const PROTO_PATH = fileURLToPath(new URL("../../src/sandbox/managed-agents-sandbox-agent.proto", import.meta.url));

interface SessionRow {
  session_id: string;
  sandbox_id: string;
  name: string;
  status: string;
  template: string;
  created_at: string;
}

export interface FakeManagedAgentsService {
  apiBaseUrl: string;
  token: string;
  sessions(): SessionRow[];
  manifests(): string[];
  execScripts(): string[];
  home(): string;
  checkpoints(sessionId: string): Array<{ checkpoint_id: string; label: string; status: string }>;
  setStatus(name: string, status: string): void;
  rejectPortForward(body: string | null): void;
  failNextLifecycleCalls(count: number, status: number): void;
  tunnelCount(): number;
  pingCount(): number;
  close(): Promise<void>;
}

function loadService(): grpc.ServiceDefinition {
  const definition = loader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const pkg = grpc.loadPackageDefinition(definition) as unknown as {
    do: {
      teams: {
        hosted_agents: { runtime: { sandbox_agent: { v1: { SandboxAgentService: grpc.ServiceClientConstructor } } } };
      };
    };
  };
  return pkg.do.teams.hosted_agents.runtime.sandbox_agent.v1.SandboxAgentService.service;
}

type Checkpoint = { checkpoint_id: string; label: string; status: string };

interface ServiceState {
  token: string;
  root: string;
  rows: Map<string, SessionRow>;
  checkpoints: Map<string, Checkpoint[]>;
  manifests: string[];
  execScripts: string[];
  counters: { tunnels: number; pings: number };
  faults: { lifecycleFailures: number; lifecycleFailureStatus: number; portForwardRejection: string | null };
}

type ExecStart = { argv?: string[]; workdir?: string; env?: Record<string, string> };
type ExecCall = grpc.ServerDuplexStream<Record<string, unknown>, unknown>;

function failExec(call: ExecCall, message: string): void {
  call.write({ stderr: Buffer.from(message) });
  call.write({ exit: { exit_code: 127, duration_ms: 0, hitl_rejected: false } });
  call.end();
}

function startExec(st: ServiceState, call: ExecCall, start: ExecStart): void {
  const argv = start.argv ?? [];
  const script = argv[argv.length - 1] ?? "";
  st.execScripts.push(script);
  try {
    const cwd = (start.workdir || st.root).replace(/^\/home\/user/, st.root);
    mkdirSync(cwd, { recursive: true });
    const child = spawn("sh", ["-c", script.replace(/\/home\/user/g, st.root)], {
      cwd,
      env: { ...process.env, ...start.env, HOME: st.root },
    });
    child.stdout.on("data", (chunk: Buffer) => call.write({ stdout: chunk }));
    child.stderr.on("data", (chunk: Buffer) => call.write({ stderr: chunk }));
    child.on("close", (code: number | null) => {
      call.write({ exit: { exit_code: code ?? -1, duration_ms: 1, hitl_rejected: false } });
      call.end();
    });
    child.on("error", (e: Error) => failExec(call, e.message));
  } catch (e) {
    failExec(call, e instanceof Error ? e.message : String(e));
  }
}

function guestHandlers(st: ServiceState): grpc.UntypedServiceImplementation {
  return {
    Exec: (call: ExecCall) => {
      call.on("data", (frame: { start?: ExecStart }) => {
        if (frame.start) startExec(st, call, frame.start);
      });
    },
    Upload: (call: grpc.ServerReadableStream<Record<string, unknown>, unknown>, cb: grpc.sendUnaryData<unknown>) => {
      let path = "";
      const chunks: Buffer[] = [];
      call.on("data", (frame: { header?: { path?: string }; chunk?: Buffer }) => {
        if (frame.header?.path) path = frame.header.path;
        if (frame.chunk?.length) chunks.push(frame.chunk);
      });
      call.on("end", () => {
        const hostPath = path.replace(/^\/home\/user/, st.root);
        mkdirSync(dirname(hostPath), { recursive: true });
        const body = Buffer.concat(chunks);
        writeFileSync(hostPath, body);
        cb(null, { path, bytes_written: String(body.length) });
      });
    },
    Download: (call: grpc.ServerWritableStream<{ path?: string }, unknown>) => {
      const hostPath = (call.request.path ?? "").replace(/^\/home\/user/, st.root);
      let body: Buffer;
      try {
        body = readFileSync(hostPath);
      } catch {
        call.emit("error", {
          code: grpc.status.INTERNAL,
          details: `envd download: download status 404: {"code":404,"message":"path '${call.request.path ?? ""}' does not exist"}`,
        });
        return;
      }
      call.write({ header: { size_bytes: String(body.length), is_archive: false } });
      call.write({ chunk: body });
      call.write({ end: { sha256: "" } });
      call.end();
    },
  };
}

const json = (res: ServerResponse, code: number, body: unknown): void => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const notFound = (res: ServerResponse, message: string): void =>
  json(res, 404, { error: { code: "not_found", message } });

function readBody(req: IncomingMessage, done: (body: string) => void): void {
  let body = "";
  req.on("data", (c: Buffer) => (body += c.toString("utf8")));
  req.on("end", () => done(body));
}

const liveRow = (st: ServiceState, id: string): SessionRow | undefined => {
  const row = st.rows.get(id);
  return row && row.status !== "SESSION_STATUS_DESTROYED" ? row : undefined;
};

function createSession(st: ServiceState, body: string, res: ServerResponse): void {
  st.manifests.push(body);
  const manifest = JSON.parse(body) as { name?: string; template?: string };
  const row: SessionRow = {
    session_id: randomUUID(),
    sandbox_id: `sbx-${st.rows.size + 1}`,
    name: manifest.name ?? "unnamed",
    status: "SESSION_STATUS_READY",
    template: manifest.template ?? "",
    created_at: new Date().toISOString(),
  };
  st.rows.set(row.session_id, row);
  json(res, 201, { session: row });
}

function createCheckpoint(st: ServiceState, id: string, body: string, res: ServerResponse): void {
  const row = liveRow(st, id);
  if (!row) return notFound(res, "no such session");
  let label: string;
  try {
    label = (JSON.parse(body) as { label?: string }).label ?? "";
  } catch {
    label = "";
  }
  const checkpoint = {
    checkpoint_id: `cp_${randomUUID().slice(0, 8)}`,
    session_id: row.session_id,
    status: "READY",
    kind: "explicit",
    label,
    created_at: new Date().toISOString(),
    size_bytes: 1,
  };
  const list = st.checkpoints.get(row.session_id) ?? [];
  list.unshift(checkpoint);
  st.checkpoints.set(row.session_id, list);
  json(res, 200, { checkpoint });
}

function checkpointRoute(st: ServiceState, req: IncomingMessage, parts: string[], res: ServerResponse): boolean {
  const id = parts[3] ?? "";
  if (parts[4] !== "checkpoints") return false;
  if (req.method === "POST" && parts.length === 5) {
    readBody(req, (body) => createCheckpoint(st, id, body, res));
    return true;
  }
  const checkpointId = decodeURIComponent(parts[5] ?? "");
  const list = st.checkpoints.get(id) ?? [];
  if (req.method === "POST" && parts[6] === "rollback" && parts.length === 7) {
    const row = liveRow(st, id);
    if (!row || !list.some((c) => c.checkpoint_id === checkpointId)) {
      notFound(res, "no such checkpoint");
      return true;
    }
    row.sandbox_id = `sbx-restored-${randomUUID().slice(0, 8)}`;
    row.status = "SESSION_STATUS_READY";
    json(res, 200, { session: row });
    return true;
  }
  if (req.method === "DELETE" && parts.length === 6) {
    st.checkpoints.set(
      id,
      list.filter((c) => c.checkpoint_id !== checkpointId),
    );
    json(res, 200, {});
    return true;
  }
  return false;
}

function sessionRoute(st: ServiceState, req: IncomingMessage, parts: string[], res: ServerResponse): boolean {
  const id = parts[3] ?? "";
  const action = parts[4] ?? "";
  const row = st.rows.get(id);
  if (req.method === "GET" && parts.length === 4) {
    if (row) json(res, 200, { session: row });
    else notFound(res, "no such session");
    return true;
  }
  if (req.method === "DELETE" && parts.length === 4) {
    if (row) row.status = "SESSION_STATUS_DESTROYED";
    res.writeHead(204).end();
    return true;
  }
  if (req.method === "POST" && (action === "pause" || action === "resume")) {
    if (!row) {
      notFound(res, "no such session");
      return true;
    }
    row.status = action === "pause" ? "SESSION_STATUS_PAUSED" : "SESSION_STATUS_READY";
    res.writeHead(204).end();
    return true;
  }
  return false;
}

function handleHttp(st: ServiceState, req: IncomingMessage, res: ServerResponse): void {
  if (req.headers.authorization !== `Bearer ${st.token}`) {
    json(res, 401, { error: { code: "unauthorized", message: "bad token" } });
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  if (req.method === "POST" && url.pathname === "/v2/agents/sessions") {
    readBody(req, (body) => createSession(st, body, res));
    return;
  }
  if (req.method === "GET" && url.pathname === "/v2/agents/sessions") {
    const name = url.searchParams.get("name");
    const all = [...st.rows.values()].filter((r) => !name || r.name === name);
    json(res, 200, { sessions: all, next_page_token: "" });
    return;
  }
  if (st.faults.lifecycleFailures > 0) {
    st.faults.lifecycleFailures -= 1;
    json(res, st.faults.lifecycleFailureStatus, { error: { code: "forbidden", message: "transient" } });
    return;
  }
  if (sessionRoute(st, req, parts, res) || checkpointRoute(st, req, parts, res)) return;
  notFound(res, url.pathname);
}

function bridgeTunnel(st: ServiceState, ws: WebSocket, guestPort: number): void {
  st.counters.tunnels += 1;
  ws.on("ping", () => {
    st.counters.pings += 1;
  });
  const upstream: Socket = connect(guestPort, "127.0.0.1");
  ws.on("message", (data: Buffer) => upstream.write(data));
  upstream.on("data", (chunk: Buffer) => ws.send(chunk));
  const shutdown = (): void => {
    upstream.destroy();
    if (ws.readyState === ws.OPEN) ws.close();
  };
  ws.on("close", shutdown);
  ws.on("error", shutdown);
  upstream.on("close", shutdown);
  upstream.on("error", shutdown);
}

function handleUpgrade(
  st: ServiceState,
  wss: WebSocketServer,
  guestPort: number,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const match = /^\/v2\/agents\/sessions\/([^/]+)\/port-forward\/(\d+)$/.exec(url.pathname);
  if (req.headers.authorization !== `Bearer ${st.token}` || !match) {
    socket.destroy();
    return;
  }
  const rejection = st.faults.portForwardRejection;
  if (rejection !== null) {
    socket.end(
      `HTTP/1.1 403 Forbidden\r\nContent-Length: ${Buffer.byteLength(rejection)}\r\nConnection: close\r\n\r\n${rejection}`,
    );
    return;
  }
  if (!liveRow(st, match[1] ?? "")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => bridgeTunnel(st, ws, guestPort));
}

async function listen(
  st: ServiceState,
  guestPort: number,
): Promise<{ http: HttpServer; wss: WebSocketServer; port: number }> {
  const http: HttpServer = createHttpServer((req, res) => handleHttp(st, req, res));
  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (req, socket, head) => handleUpgrade(st, wss, guestPort, req, socket, head));
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("fake managed agents service failed to bind");
  return { http, wss, port: address.port };
}

export async function startFakeManagedAgentsService(): Promise<FakeManagedAgentsService> {
  const st: ServiceState = {
    token: "dop_v1_test-token",
    root: mkdtempSync(join(tmpdir(), "fake-managed-agents-guest-")),
    rows: new Map(),
    checkpoints: new Map(),
    manifests: [],
    execScripts: [],
    counters: { tunnels: 0, pings: 0 },
    faults: { lifecycleFailures: 0, lifecycleFailureStatus: 403, portForwardRejection: null },
  };
  const guest = new grpc.Server();
  guest.addService(loadService(), guestHandlers(st));
  const guestPort = await new Promise<number>((resolve, reject) => {
    guest.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (err, port) =>
      err ? reject(err) : resolve(port),
    );
  });
  const { http, wss, port } = await listen(st, guestPort);
  return {
    apiBaseUrl: `http://127.0.0.1:${port}`,
    token: st.token,
    sessions: () => [...st.rows.values()],
    manifests: () => [...st.manifests],
    execScripts: () => [...st.execScripts],
    home: () => st.root,
    checkpoints: (sessionId) => [...(st.checkpoints.get(sessionId) ?? [])],
    setStatus: (name, status) => {
      const row = [...st.rows.values()].find((r) => r.name === name && r.status !== "SESSION_STATUS_DESTROYED");
      if (row) row.status = status;
    },
    rejectPortForward: (body) => {
      st.faults.portForwardRejection = body;
    },
    failNextLifecycleCalls: (count, status) => {
      st.faults.lifecycleFailures = count;
      st.faults.lifecycleFailureStatus = status;
    },
    tunnelCount: () => st.counters.tunnels,
    pingCount: () => st.counters.pings,
    close: async () => {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      guest.forceShutdown();
      rmSync(st.root, { recursive: true, force: true });
    },
  };
}
