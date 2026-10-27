import { randomUUID } from "node:crypto";
import {
  argAfter,
  emitCheckTool,
  is,
  type MockScenario,
  notSent,
  scenario,
  silentFire,
  slackPost,
  startsWith,
  streamChunks,
  streamText,
  tool,
} from "./shared.ts";

const WORKLOG = "worklog: did the thing but never posted";

export const REPLY_SCENARIOS: MockScenario[] = [
  scenario("silent", is("!silent"), () => ""),
  scenario("addressed-nudge", startsWith("[system] You were addressed"), async (t) => {
    if (t.state.shedSessions.has(t.turn.session.id)) return WORKLOG;
    const r = await slackPost(t, "nudged reply", undefined, { action: "post" });
    t.usedTool = true;
    return r.ok ? "(posted after nudge)" : notSent(r);
  }),
  scenario("shedmute", startsWith("!shedmute"), (t) => {
    t.state.shedSessions.add(t.turn.session.id);
    t.muteReply = true;
    return WORKLOG;
  }),
  scenario("shed", startsWith("!shed"), (t) => {
    t.state.shedSessions.add(t.turn.session.id);
    return WORKLOG;
  }),
  tool("preamble-then-quiet", startsWith("!preamble-then-quiet"), async (t) => {
    const { turn } = t;
    const preamble = argAfter(t, "!preamble-then-quiet").trim() || "Still queued — silent.";
    streamText(turn, preamble);
    await turn.emit({ kind: "AgentMessage", variant: "narration", text: preamble });
    await emitCheckTool(turn);
    t.silent = turn.pollFire === true;
    return turn.pollFire ? "" : preamble;
  }),
  scenario("phased-reply", startsWith("!phased-reply"), async ({ turn }) => {
    await turn.onTextBlockStart?.("commentary");
    turn.onDelta?.("Checking.");
    await turn.emit({ kind: "AgentMessage", variant: "narration", text: "Checking.", body: { phase: "commentary" } });
    await turn.onTextBlockStart?.("final_answer");
    return "All clear.";
  }),
  tool("preamble", startsWith("!preamble"), async (t) => {
    const { turn } = t;
    const text = argAfter(t, "!preamble").trim() || "On it — checking.";
    streamText(turn, text);
    await turn.emit({ kind: "AgentMessage", variant: "narration", text });
    await emitCheckTool(turn);
    turn.onTextBlockStart?.();
    return `${text}\n\nAll clear — nothing broke.`;
  }),
  tool("speakpost", startsWith("!speakpost "), async (t) => {
    const msg = argAfter(t, "!speakpost ");
    streamText(t.turn, "Answering directly.");
    const r = await slackPost(t, msg);
    return r.ok ? "(posted)" : notSent(r);
  }),
  tool("finish-silent", is("!finish-silent"), async (t) => {
    t.silent = silentFire(t);
    if (!t.silent) return "Nothing to report; ending silently.";
    await t.turn.emit({ kind: "ToolCall", tool: "finish_silently" });
    await t.turn.emit({ kind: "ToolResult", tool: "finish_silently", body: { silent: true } });
    return "";
  }),
  tool("finish-silent-approval", is("!finish-silent-approval"), (t) => {
    t.silent = silentFire(t);
    t.collected.push({ command: "gated-check", reason: "requires approval" });
    return t.silent ? "" : "I couldn't finish one check, but nothing to report.";
  }),
  scenario("cachemiss", is("!cachemiss"), () => "re-prefilled the prefix"),
  scenario("histcount", is("!histcount"), ({ turn }) => `history:${turn.history.length}`),
  scenario("sysprompt", is("!sysprompt"), ({ turn }) =>
    [turn.systemPrompt, turn.environment].filter((s) => s && s.trim()).join("\n\n"),
  ),
  scenario("wallclock", is("!wallclock"), ({ turn }) => `wallclock:${turn.turnWallClockMs ?? 0}`),
  scenario("surfacename", is("!surfacename"), ({ turn }) => `surface:${turn.surfaceName ?? "none"}`),
  scenario("think", startsWith("!think "), async ({ turn, command0 }) => {
    const thinking = command0.slice("!think ".length);
    const step = { id: randomUUID(), index: 0 };
    for (const chunk of streamChunks(thinking)) turn.onReasoningDelta?.(step.id, step.index, chunk);
    await turn.emit({
      kind: "Reasoning",
      text: thinking,
      step: step.index,
      body: { thinkingSignature: "OPAQUE-SIG-BYTES", wire: { message: { id: step.id } } },
    });
    return "thought about it";
  }),
];
