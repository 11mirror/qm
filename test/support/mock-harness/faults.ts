import { NonRetryableTurnError, ProviderTurnError } from "../../../src/core/turn-error.ts";
import { recordStoppedTurn } from "../../../src/harness/harness-shared.ts";
import { argAfter, is, type MockScenario, notSent, scenario, slackPost, startsWith, tool } from "./shared.ts";

const TURN_FAULT = "boom: simulated turn fault";

export const FAULT_SCENARIOS: MockScenario[] = [
  scenario("boom", is("!boom"), () => {
    throw new Error(TURN_FAULT);
  }),
  scenario(
    "boom-always",
    (t) => t.command0 === "!boom-always" || t.state.boomAlwaysSessions.has(t.turn.session.id),
    (t) => {
      t.state.boomAlwaysSessions.add(t.turn.session.id);
      throw new Error(TURN_FAULT);
    },
  ),
  tool(
    "resume-pending-post",
    (t) => t.state.resumePostSessions.has(t.turn.session.id),
    async (t) => {
      const msg = t.state.resumePostSessions.get(t.turn.session.id)!;
      t.state.resumePostSessions.delete(t.turn.session.id);
      const r = await slackPost(t, msg);
      return r.ok ? "(posted after resume)" : notSent(r);
    },
  ),
  scenario(
    "finish-after-shutdown",
    (t) => t.state.shutdownResumeSessions.has(t.turn.session.id),
    (t) => {
      t.state.shutdownResumeSessions.delete(t.turn.session.id);
      return "finished after resume";
    },
  ),
  scenario("work-until-shutdown", is("!work-until-shutdown"), async (t) => {
    const { turn } = t;
    await turn.emit({ kind: "ToolCall", tool: "execute", callId: "build", body: { command: "make build" } });
    await turn.emit({ kind: "ToolResult", tool: "execute", callId: "build", body: { ok: true } });
    t.state.shutdownResumeSessions.add(turn.session.id);
    await new Promise<void>((resolve) => {
      if (!turn.cancel || turn.cancel.aborted) resolve();
      else turn.cancel.addEventListener("abort", () => resolve(), { once: true });
    });
    await recordStoppedTurn(turn, "");
    return { stop: { reply: "(stopped)", stopped: true, modelCalls: 1 } };
  }),
  scenario("post-lost-result", startsWith("!post-lost-result "), async (t) => {
    const msg = argAfter(t, "!post-lost-result ");
    await t.turn.emit({ kind: "ToolCall", tool: "slack", body: { action: "post", bytes: msg.length } });
    await t.turn.tools.post(msg);
    t.state.resumePostSessions.set(t.turn.session.id, `${msg} (repost)`);
    throw new Error("boom: simulated fault before the post's tool result landed");
  }),
  scenario("over-budget", is("!over-budget"), () => {
    throw new ProviderTurnError("Model provider API error (budget_exceeded): ExceededBudget", {
      code: "model_budget",
      retryable: false,
      status: 429,
      raw: '429: {"message":"ExceededBudget: Team=team-a over 1d budget.","type":"budget_exceeded"}',
    });
  }),
  scenario("post-then-boom", startsWith("!post-then-boom "), async (t) => {
    const rest = argAfter(t, "!post-then-boom ");
    const bar = rest.indexOf("|");
    const first = bar === -1 ? rest : rest.slice(0, bar);
    const second = bar === -1 ? rest : rest.slice(bar + 1);
    await slackPost(t, first);
    t.state.resumePostSessions.set(t.turn.session.id, second);
    throw new Error("boom: simulated fault after a completed post");
  }),
  scenario("work-then-boom", is("!work-then-boom"), async (t) => {
    await t.turn.emit({ kind: "ToolCall", tool: "execute", body: { command: "make build" } });
    await t.turn.emit({ kind: "ToolResult", tool: "execute", body: { ok: true } });
    throw new Error("boom: simulated mid-turn fault");
  }),
  scenario("refuse", is("!refuse"), () => {
    throw new NonRetryableTurnError(
      "API integrators: you can reduce refusals for your users by configuring a fallback model",
    );
  }),
];
