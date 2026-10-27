import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDetectionPrompt, parseDetectVerdict, renderDetectPrompt } from "../../src/harness/pi-aux-prompts.ts";
import { storedItem } from "../../src/sessions/items.ts";

test("parseDetectVerdict: a YES whose rationale contains 'no' still replies (anchored on the verdict token)", () => {
  assert.equal(parseDetectVerdict("YES (a direct answer to you, no mention needed)", false).respond, true);
  assert.equal(parseDetectVerdict("YES — no question mark, but it's feedback aimed at you", true).respond, true);
  assert.equal(parseDetectVerdict("Verdict: YES (no mention needed)", false).respond, true);
  assert.equal(parseDetectVerdict("**YES** — follow-up to your work", false).respond, true);
});

test("parseDetectVerdict: NO verdicts stay silent even when the rationale contains 'yes'", () => {
  assert.equal(parseDetectVerdict("NO (they said yes to each other, not to you)", false).respond, false);
  assert.equal(parseDetectVerdict("Answer: no — chit-chat", false).respond, false);
  assert.equal(parseDetectVerdict("", false).respond, false);
  assert.equal(parseDetectVerdict("Maybe?", false).respond, false, "an unrecognized verdict fails quiet");
  assert.equal(parseDetectVerdict("Eyes on this one", false).respond, false, "'yes' inside a word does not count");
});

test("parseDetectVerdict: REACT verdicts return reactions without replying", () => {
  const r = parseDetectVerdict("REACT :pray:", true);
  assert.equal(r.respond, false);
  assert.deepEqual(r.reactions, ["pray"]);
  const noEmoji = parseDetectVerdict("REACT", true);
  assert.equal(noEmoji.respond, false);
  assert.equal(noEmoji.reactions, undefined);
  assert.equal(parseDetectVerdict("REACT :pray:", false).respond, false, "reactions disabled → REACT is not a YES");
});

test("turn-detection prompt treats plain-text assistant handle + sensitive question as a reply", () => {
  const prompt = buildDetectionPrompt("Use :pray: for thanks.");
  assert.match(prompt, /plain-text assistant name\/handle/);
  assert.match(prompt, /"agent prod"/);
  assert.match(prompt, /Do NOT choose NO just because the topic is legal/);
});

test("turn-detection prompt says conversational flow can imply the assistant should answer", () => {
  const prompt = buildDetectionPrompt();
  assert.match(prompt, /conversation flow/);
  assert.match(prompt, /no mention needed/);
  assert.match(prompt, /can you send the chart/);
});

test("turn-detection prompt treats implied assistant-target follow-ups as addressed", () => {
  const prompt = buildDetectionPrompt();
  assert.match(prompt, /implied target is the assistant/);
  assert.match(prompt, /even if the assistant is not explicitly mentioned/);
  assert.match(prompt, /what do you mean by that\?/);
  assert.match(prompt, /what is available now\?/);
  assert.match(prompt, /<@U123> what do you mean by that\?[^]*NO/);
});

test("renderDetectPrompt uses prior assistant replies, not assembled prior user prompts", () => {
  const prompt = renderDetectPrompt({
    session: {} as any,
    message: "yes, send it",
    recentContext: "carol: Can you send the chart?",
    systemPrompt: "You are Agent Prod.",
    history: [
      storedItem(
        {
          kind: "UserMessage",
          text: "## The conversation right now\nnoisy rendered Slack block\n\nCan you send the chart?",
        },
        { sessionId: "s", seq: 1, createdAt: 1 },
      ),
      storedItem(
        { kind: "AgentMessage", text: "I can send the chart if you share it again." },
        { sessionId: "s", seq: 2, createdAt: 2 },
      ),
    ],
    recordModelCall() {},
  });

  assert.match(prompt, /Your earlier replies in this thread/);
  assert.match(prompt, /I can send the chart if you share it again/);
  assert.doesNotMatch(prompt, /noisy rendered Slack block/);
  assert.match(prompt, /NEWEST message:\nyes, send it/);
});
