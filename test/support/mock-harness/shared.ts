import { randomUUID } from "node:crypto";
import type { HarnessTurnInput, HarnessTurnResult } from "../../../src/harness/harness.ts";
import type { NeedsApproval } from "../../../src/tools/primitives.ts";
import { isReply, isUserMessage } from "../../../src/sessions/items.ts";

export interface MockHarnessState {
  shedSessions: Set<string>;
  boomAlwaysSessions: Set<string>;
  resumePostSessions: Map<string, string>;
  shutdownResumeSessions: Set<string>;
  flakyScreens: Set<string>;
}

export function createMockHarnessState(): MockHarnessState {
  return {
    shedSessions: new Set(),
    boomAlwaysSessions: new Set(),
    resumePostSessions: new Map(),
    shutdownResumeSessions: new Set(),
    flakyScreens: new Set(),
  };
}

export type PendingApproval = NonNullable<HarnessTurnResult["pendingApprovals"]>[number] & {
  summary?: string;
};

export interface MockTurn {
  turn: HarnessTurnInput;
  cmd: string;
  command0: string;
  modelPrompt: string;
  state: MockHarnessState;
  usedTool: boolean;
  silent: boolean;
  muteReply: boolean;
  pausedOnApproval: boolean;
  collected: PendingApproval[];
}

export interface MockStop {
  stop: HarnessTurnResult;
}

export type MockOutcome = string | MockStop;

export interface MockScenario {
  name: string;
  matches(t: MockTurn): boolean | undefined;
  run(t: MockTurn): MockOutcome | Promise<MockOutcome>;
}

export function scenario(name: string, matches: MockScenario["matches"], run: MockScenario["run"]): MockScenario {
  return { name, matches, run };
}

export function tool(name: string, matches: MockScenario["matches"], run: MockScenario["run"]): MockScenario {
  return scenario(name, matches, async (t) => {
    const outcome = await run(t);
    t.usedTool = true;
    return outcome;
  });
}

export const silentFire = (t: MockTurn) => t.turn.pollFire === true || t.turn.surfaceTools === true;

export const is = (command: string) => (t: MockTurn) => t.command0 === command;
export const startsWith = (prefix: string) => (t: MockTurn) => t.command0.startsWith(prefix);

export const argAfter = (t: MockTurn, tag: string) => t.cmd.slice(t.cmd.indexOf(tag) + tag.length);

export function splitWord(rest: string): [string, string] {
  const sp = rest.indexOf(" ");
  return sp === -1 ? [rest, ""] : [rest.slice(0, sp), rest.slice(sp + 1)];
}

export const execOutput = (r: { stdout: string; stderr: string; code: number | null }) =>
  r.stdout.trim() || r.stderr.trim() || `(exit ${r.code})`;

export const failure = (label: string, r: { message?: string }, fallback = "failed") =>
  `${label} ${r.message ?? fallback}`;

export const notSent = (r: { message?: string }) => failure("[not sent]", r);

export function streamChunks(text: string): string[] {
  if (!text) return [];
  const size = Math.max(1, Math.ceil(text.length / 3));
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

export function streamText(turn: HarnessTurnInput, text: string): void {
  if (turn.onDelta) for (const chunk of streamChunks(text)) turn.onDelta(chunk);
}

export function toolResult(t: MockTurn, tool: string, body: Record<string, unknown>) {
  return t.turn.emit({ kind: "ToolResult", tool, body });
}

export async function emitCheckTool(turn: HarnessTurnInput): Promise<void> {
  await turn.emit({ kind: "ToolCall", tool: "execute", body: { command: "check" } });
  await turn.emit({ kind: "ToolResult", tool: "execute", body: { ok: true } });
}

type PostOptions = Parameters<HarnessTurnInput["tools"]["post"]>[1];

export async function slackPost(
  t: MockTurn,
  msg: string,
  options?: PostOptions,
  callBody: Record<string, unknown> = { action: "post", bytes: msg.length },
) {
  await t.turn.emit({ kind: "ToolCall", tool: "slack", body: callBody });
  const r = options ? await t.turn.tools.post(msg, options) : await t.turn.tools.post(msg);
  await toolResult(t, "post", { ok: r.ok });
  return r;
}

export function approvalFrom(e: NeedsApproval): PendingApproval {
  return {
    command: e.command,
    reason: e.approvalReason,
    kind: e.kind,
    matched: e.matched,
    ...(e.approvalKey ? { approvalKey: e.approvalKey } : {}),
    ...(e.grantModes ? { grantModes: e.grantModes } : {}),
  };
}

export function mockProviderMessages(
  history: HarnessTurnInput["history"],
): Array<{ role: "user" | "assistant"; content: string }> {
  return history.flatMap((e): Array<{ role: "user" | "assistant"; content: string }> => {
    const content = e.text ?? "";
    if (!content.trim()) return [];
    if (isUserMessage(e)) return [{ role: "user", content }];
    return isReply(e) ? [{ role: "assistant", content }] : [];
  });
}

export function withCallIds(emit: HarnessTurnInput["emit"]): HarnessTurnInput["emit"] {
  const open: string[] = [];
  return (item) => {
    if (item.kind !== "ToolCall" && item.kind !== "ToolResult") return emit(item);
    let callId = item.callId;
    if (!callId) {
      callId = item.kind === "ToolCall" ? `mock-call-${randomUUID()}` : (open.shift() ?? `mock-call-${randomUUID()}`);
      if (item.kind === "ToolCall") open.push(callId);
    } else if (item.kind === "ToolCall") open.push(callId);
    else open.splice(open.indexOf(callId), open.includes(callId) ? 1 : 0);
    return emit({ ...item, callId });
  };
}
