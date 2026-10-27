import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface RemapOptions {
  home: string;
  root?: string;
  guest: RegExp;
  rewrites?: Array<[RegExp, string]>;
}

export function remapScript(script: string, opts: RemapOptions): string {
  const root = opts.root ?? opts.home;
  const rootRe = escapeRe(root);
  const remapPath = new RegExp(`${rootRe}/tmp/|${rootRe}(?![A-Za-z0-9._-])|/tmp/`, "g");
  let out = script.replace(/\btimeout \d+ /g, "");
  for (const [re, to] of opts.rewrites ?? []) out = out.replace(re, to);
  out = out.replace(opts.guest, root).replace(remapPath, (m) => (m.startsWith(root) ? m : `${root}/tmp/`));
  return `export HOME=${JSON.stringify(opts.home)}; ${out}`;
}

export interface ShellRun {
  stdout: Buffer;
  stderr: Buffer;
  code: number;
}

export function runShell(
  script: string,
  opts: { env?: Record<string, string | undefined>; input?: Buffer } = {},
): ShellRun {
  const r = spawnSync("sh", ["-c", script], {
    encoding: "buffer",
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, ...opts.env, COPYFILE_DISABLE: "1" },
    ...(opts.input ? { input: opts.input } : {}),
  });
  return {
    stdout: r.stdout ?? Buffer.alloc(0),
    stderr: r.stderr ?? Buffer.alloc(0),
    code: r.status ?? (r.signal ? 137 : -1),
  };
}

export function textResult(run: ShellRun, map: (s: string) => string = (s) => s) {
  return { stdout: map(run.stdout.toString("utf8")), stderr: map(run.stderr.toString("utf8")), exitCode: run.code };
}

export function readHostFile(hostPath: string): Uint8Array | null {
  if (!existsSync(hostPath)) return null;
  return new Uint8Array(readFileSync(hostPath));
}

export function writeHostFile(hostPath: string, data: Uint8Array): void {
  mkdirSync(dirname(hostPath), { recursive: true });
  writeFileSync(hostPath, Buffer.from(data));
}

export function latestByName<R extends { createdAt: number }>(
  records: Iterable<R>,
  matches: (r: R) => boolean,
  live: (r: R) => boolean,
): R | undefined {
  const all = [...records].filter(matches).sort((a, b) => b.createdAt - a.createdAt);
  return all.find(live) ?? all[0];
}

export const toBuf = (body: unknown): Buffer => {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === "string") return Buffer.from(body);
  return Buffer.alloc(0);
};
