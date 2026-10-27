import {
  argAfter,
  failure,
  is,
  type MockScenario,
  notSent,
  scenario,
  slackPost,
  splitWord,
  startsWith,
  tool,
  toolResult,
} from "./shared.ts";

export const SLACK_SCENARIOS: MockScenario[] = [
  tool("reachchan", startsWith("!reachchan "), async (t) => {
    const [channel, msg] = splitWord(argAfter(t, "!reachchan "));
    await t.turn.emit({ kind: "ToolCall", tool: "reach", body: { channel, bytes: msg.length } });
    const r = await t.turn.tools.reach(msg, { channel });
    await toolResult(t, "reach", { ok: r.ok });
    return r.ok ? `(reached ${r.matched ?? channel})` : notSent(r);
  }),
  tool("postthread", startsWith("!postthread "), async (t) => {
    const [threadTs, msg] = splitWord(argAfter(t, "!postthread "));
    const r = await slackPost(t, msg, { ts: threadTs }, { action: "post", ts: threadTs, bytes: msg.length });
    return r.ok ? "(posted in thread)" : notSent(r);
  }),
  tool("broadcast", startsWith("!broadcast "), async (t) => {
    const msg = argAfter(t, "!broadcast ");
    const r = await slackPost(t, msg, { broadcast: true }, { action: "post", broadcast: true, bytes: msg.length });
    return r.ok ? "(broadcast to channel)" : notSent(r);
  }),
  tool("post2", startsWith("!post2 "), async (t) => {
    const rest = argAfter(t, "!post2 ");
    const bar = rest.indexOf("|");
    let sent = 0;
    for (const msg of bar === -1 ? [rest] : [rest.slice(0, bar), rest.slice(bar + 1)]) {
      if ((await slackPost(t, msg)).ok) sent++;
    }
    return `(posted ${sent})`;
  }),
  tool("post", startsWith("!post "), async (t) => {
    const r = await slackPost(t, argAfter(t, "!post "));
    return r.ok ? "(posted)" : notSent(r);
  }),
  tool("postfiles", startsWith("!postfiles "), async (t) => {
    const [head, msg] = splitWord(argAfter(t, "!postfiles "));
    const r = await t.turn.tools.post(msg, undefined, head.split(",").filter(Boolean));
    await toolResult(t, "post", { ok: r.ok });
    return r.ok ? "(posted files)" : notSent(r);
  }),
  tool("react", startsWith("!react "), async (t) => {
    const [, ts, emoji] = t.command0.split(/\s+/);
    const r = await t.turn.tools.react({ ts: ts ?? "", emoji: emoji ?? "" });
    await toolResult(t, "react", { ok: r.ok });
    return r.ok ? "(reacted)" : failure("[not reacted]", r);
  }),
  tool("edit", startsWith("!edit "), async (t) => {
    const [ref, text] = splitWord(argAfter(t, "!edit "));
    const r = await t.turn.tools.edit({ ref, text });
    await toolResult(t, "edit", { ok: r.ok });
    return r.ok ? "(edited)" : failure("[not edited]", r);
  }),
  tool("delete", startsWith("!delete "), async (t) => {
    const [, ref] = t.command0.split(/\s+/);
    const r = await t.turn.tools.delete({ ref: ref ?? "" });
    await toolResult(t, "delete", { ok: r.ok });
    return r.ok ? "(deleted)" : failure("[not deleted]", r);
  }),
  tool(
    "read_thread",
    (t) => t.command0 === "!read_thread" || t.command0.startsWith("!read_thread "),
    async (t) => {
      const r = await t.turn.tools.readThread();
      const count = (r.messages ?? []).length;
      await toolResult(t, "read_thread", { ok: r.ok, count });
      return r.ok ? `read ${count} message(s)` : failure("[couldn't read]", r, "unavailable");
    },
  ),
  tool("whats_new", is("!whats_new"), async (t) => {
    const r = await t.turn.tools.whatsNew();
    await toolResult(t, "whats_new", { ok: r.ok });
    return r.ok
      ? `whats_new here=${r.hereNew ?? 0} others=${r.activeSubConversations ?? 0}${r.coverageSince ? ` coverage=${r.coverageSince}` : ""}`
      : failure("[couldn't check]", r, "unavailable");
  }),
  tool("search", startsWith("!search "), async (t) => {
    let q = argAfter(t, "!search ");
    let source: "mirror" | "slack" | undefined;
    const sourceMatch = q.match(/^source=(mirror|slack)\s+/);
    if (sourceMatch) {
      source = sourceMatch[1] as "mirror" | "slack";
      q = q.slice(sourceMatch[0].length);
    }
    const r = await t.turn.tools.search(q, source ? { source } : undefined);
    const hits = r.hits ?? [];
    await toolResult(t, "search", { ok: r.ok, count: hits.length });
    const first = hits[0];
    return r.ok
      ? `search(${r.source ?? "?"}) ${hits.length} hit(s)${first ? ` first=${first.author ?? "?"}:${first.snippet}` : ""}${r.coverageSince ? ` coverage=${r.coverageSince}` : ""}`
      : failure("[couldn't search]", r, "unavailable");
  }),
  tool("read_members", is("!read_members"), async (t) => {
    const r = await t.turn.tools.readMembers();
    const members = r.members ?? [];
    await toolResult(t, "read_members", { ok: r.ok, count: members.length });
    return r.ok
      ? `members: ${members.map((m) => m.displayName).join(", ")}`
      : failure("[couldn't read members]", r, "unavailable");
  }),
  tool("read_file", startsWith("!read_file "), async (t) => {
    const r = await t.turn.tools.readFile(argAfter(t, "!read_file ").trim());
    await toolResult(t, "read_file", { ok: r.ok });
    if (!r.ok) return failure("[couldn't read file]", r, "unavailable");
    if (r.content !== undefined) return `file: ${r.content}`;
    return `file-pointer: ${r.sizeBytes ?? 0}B ${r.contentType ?? "binary"}`;
  }),
  tool("set_instructions", startsWith("!set_instructions "), async (t) => {
    const r = await t.turn.tools.instructionsWrite(argAfter(t, "!set_instructions ").trim());
    await toolResult(t, "set_instructions", { ok: r.ok });
    return r.ok ? "instructions set" : `[couldn't set instructions] ${r.message}`;
  }),
  tool("get_instructions", is("!get_instructions"), async (t) => {
    const r = t.turn.tools.instructionsRead();
    await toolResult(t, "get_instructions", { ok: !("code" in r) });
    return "code" in r ? "[couldn't read instructions]" : `instructions: ${r.instructions || "(none)"}`;
  }),
  scenario("priorturns", is("!priorturns"), ({ turn }) =>
    turn.priorTurns?.length
      ? "priorturns:\n" + turn.priorTurns.map((p) => `${p.role}${p.name ? `/${p.name}` : ""}: ${p.text}`).join("\n")
      : "priorturns:none",
  ),
  scenario("overheard", is("!overheard"), ({ turn }) =>
    turn.overheard?.length
      ? "overheard:\n" +
        turn.overheard
          .map((m) => `${m.name ?? "you"}@${m.ts}: ${m.text}${m.files?.length ? ` [${m.files.join(",")}]` : ""}`)
          .join("\n")
      : "overheard:none",
  ),
];
