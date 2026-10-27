import { readFileSync } from "node:fs";
import { join } from "node:path";
import { errMessage } from "../lib/util.ts";
import type { CanaryReply, ChildName, SlackHealth } from "../lib/types.ts";

export function logTail(lock: string, name: ChildName, lines = 20): string[] {
  try {
    return readFileSync(join(lock, `${name}.log`), "utf8")
      .trimEnd()
      .split("\n")
      .slice(-lines);
  } catch {
    return [];
  }
}

export async function fetchSlackHealth(port: number): Promise<SlackHealth | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return (await res.json()) as SlackHealth;
  } catch {
    return null;
  }
}

export async function runCanary(port: number, channel: string, timeoutMs = 15_000): Promise<CanaryReply> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/canary`, {
      method: "POST",
      body: JSON.stringify({ channel, timeoutMs }),
      signal: AbortSignal.timeout(timeoutMs + 5000),
    });
    return (await res.json()) as CanaryReply;
  } catch (err) {
    return { ok: false, reason: `canary endpoint unreachable: ${errMessage(err)}` };
  }
}

export async function readBody(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}
