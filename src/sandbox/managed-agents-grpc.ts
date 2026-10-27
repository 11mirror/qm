import { fileURLToPath } from "node:url";
import { errMessage } from "../util/errors.ts";

export const MAX_EXEC_OUTPUT_BYTES = 16 * 1024 * 1024;
const GRPC_NOT_FOUND = 5;
export const GRPC_UNAVAILABLE = 14;

const PROTO_PATH = fileURLToPath(new URL("./managed-agents-sandbox-agent.proto", import.meta.url));

interface GrpcCallError {
  code?: number;
  details?: string;
  message?: string;
}

export const grpcCode = (err: unknown): number | undefined =>
  typeof err === "object" && err !== null ? (err as GrpcCallError).code : undefined;

export const isGuestGone = (err: unknown): boolean => {
  const code = grpcCode(err);
  return code === GRPC_NOT_FOUND || code === GRPC_UNAVAILABLE;
};

export const isMissingFile = (err: unknown): boolean =>
  grpcCode(err) === GRPC_NOT_FOUND || /\bdownload status 404\b/.test((err as GrpcCallError).details ?? "");

type ProtoLoader = typeof import("@grpc/proto-loader");
type Grpc = typeof import("@grpc/grpc-js");

interface GrpcDuplex {
  write(msg: unknown): void;
  end(): void;
  cancel(): void;
  on(event: string, cb: (arg: never) => void): void;
}

type GrpcWritable = Pick<GrpcDuplex, "write" | "end" | "on">;
type GrpcReadable = Pick<GrpcDuplex, "on" | "cancel">;

export interface SandboxAgent {
  Exec(): GrpcDuplex;
  Upload(cb: (err: unknown, res?: { bytes_written?: string }) => void): GrpcWritable;
  Download(req: unknown): GrpcReadable;
  waitForReady(deadline: Date, cb: (err?: Error) => void): void;
  close(): void;
}

export interface ExecOutputFrame {
  output?: "stdout" | "stderr" | "exit";
  stdout?: Buffer;
  stderr?: Buffer;
  exit?: { exit_code?: number; hitl_rejected?: boolean; timed_out?: boolean };
}

export interface DownloadFrame {
  output?: "header" | "chunk" | "end";
  chunk?: Buffer;
}

let grpcModules: Promise<[ProtoLoader, Grpc]> | null = null;

function loadGrpc(): Promise<[ProtoLoader, Grpc]> {
  grpcModules ??= Promise.all([
    import("@grpc/proto-loader").catch((e: unknown) => {
      throw new Error(`@grpc/proto-loader is not installed: ${errMessage(e)}`);
    }),
    import("@grpc/grpc-js").catch((e: unknown) => {
      throw new Error(`@grpc/grpc-js is not installed: ${errMessage(e)}`);
    }),
  ]) as Promise<[ProtoLoader, Grpc]>;
  return grpcModules;
}

export async function dialSandboxAgent(localPort: number, readyTimeoutMs: number): Promise<SandboxAgent> {
  const [loader, grpc] = await loadGrpc();
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
        hosted_agents: {
          runtime: {
            sandbox_agent: {
              v1: {
                SandboxAgentService: new (
                  addr: string,
                  creds: ReturnType<Grpc["credentials"]["createInsecure"]>,
                  options: Record<string, number>,
                ) => SandboxAgent;
              };
            };
          };
        };
      };
    };
  };
  const Service = pkg.do.teams.hosted_agents.runtime.sandbox_agent.v1.SandboxAgentService;
  const agent = new Service(`127.0.0.1:${localPort}`, grpc.credentials.createInsecure(), {
    "grpc.max_receive_message_length": MAX_EXEC_OUTPUT_BYTES,
    "grpc.max_send_message_length": MAX_EXEC_OUTPUT_BYTES,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      agent.waitForReady(new Date(Date.now() + readyTimeoutMs), (err?: Error) => (err ? reject(err) : resolve()));
    });
  } catch (e) {
    agent.close();
    throw e;
  }
  return agent;
}
