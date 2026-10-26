// The memory and history tools: notebook facts and this conversation's own transcript.

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MemoryDisclosureDenied } from "../../memory/disclosure.ts";
import { MemoryFactsMissing } from "../../memory/facts.ts";
import { type ToolKit } from "./kit.ts";
import { optionalInteger, optionalString, text } from "./shared.ts";

export function memoryTools(kit: ToolKit) {
  const { ref, opts, recordCall, recordText, recordFail } = kit;
  const memory = defineTool({
    name: "memory",
    label: "memory",
    description:
      "Your durable memory of the person or team you work for — the ONE way to read or change it. " +
      "It is NOT a file: writing MEMORY.md with files or the shell does not touch it. It persists across every conversation and surface (continuity — " +
      "you're a colleague who remembers, not a fresh chat each time). Reads may span authorized " +
      "notebooks; writes only change this conversation's own notebook. " +
      'action="search" finds remembered facts matching every word of `query` (case-insensitive) ' +
      "across every notebook this conversation may read — check what you already know before asking. " +
      "Only a bounded selection of memories is loaded into context; search the full notebooks " +
      "for facts missing from that selection. Keep memory concise. Save pointers to data, never the data " +
      "itself — working state (queues, backlogs, watermarks, ID lists, logs, per-item status) " +
      "belongs in a file written with the files tool, with at most one memory line naming that file and what " +
      "it holds. If a fact is a list that grows, it's a file. Files are this " +
      "conversation's own (a pointer read from another conversation is a hint of where state " +
      "lives, not a path you can open). " +
      'action="add" saves new `facts` ([{text}, …]) now — short, self-contained facts (a preference, ' +
      "an identifier, an ongoing project, how they like to work); never secrets, credentials, " +
      "one-off trivia, or anything already recorded somewhere you can look up. " +
      'action="read" lists this conversation\'s notebook, each fact with its #id; pass `scope` from a search result to read another authorized notebook. ' +
      'action="edit" replaces the text of existing facts (`facts`: [{id, text}, …]); ' +
      'action="delete" forgets facts by `ids`. Fix a fact that changed instead of adding a contradicting one, ' +
      "and delete what is wrong or stale. Ids come from search or read; an edit or delete that names any id " +
      "not in this conversation's notebook changes nothing and says which ids were bad.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("search"),
          Type.Literal("read"),
          Type.Literal("add"),
          Type.Literal("edit"),
          Type.Literal("delete"),
        ],
        { description: "search facts, read this notebook, or add, edit, or delete facts." },
      ),
      query: optionalString("search only: words to look for among your remembered facts (all must match)."),
      limit: optionalInteger("search only: max facts to return (default 20)."),
      scope: optionalString(
        "search/read only: exact notebook scope ID from a search result. Omit to search all authorized notebooks or read your own.",
      ),
      facts: Type.Optional(
        Type.Array(
          Type.Object({
            id: optionalString("edit only: the fact's id, e.g. #42."),
            text: Type.String({
              description: "one short self-contained fact — a pointer to data, never the data itself.",
            }),
          }),
          { description: "add: [{text}, …]; edit: [{id, text}, …]." },
        ),
      ),
      ids: Type.Optional(Type.Array(Type.String(), { description: "delete only: ids of the facts to forget." })),
    }),
    async execute(callId, params) {
      const tc = ref.current;
      if (!tc) return text("[error] no active tool context");
      const action = params.action;
      await recordCall(callId, {
        tool: "memory",
        action,
        ...(params.scope !== undefined ? { scope: params.scope } : {}),
        ...(params.query !== undefined ? { query: params.query } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
        ...(params.facts !== undefined ? { facts: params.facts } : {}),
        ...(params.ids !== undefined ? { ids: params.ids } : {}),
      });
      const fail = (error: string) => recordFail(callId, { tool: "memory", action, error }, `[error] ${error}`);
      const unavailable = () =>
        recordFail(
          callId,
          { tool: "memory", action, unavailable: true },
          "[memory isn't available in this conversation]",
        );
      if (params.scope !== undefined && action !== "search" && action !== "read") {
        return recordFail(
          callId,
          { tool: "memory", action, error: "scope is read-only" },
          "[error] scope is only allowed for memory search/read; writes stay in this conversation.",
        );
      }
      if (opts?.readOnly && action !== "search" && action !== "read") {
        return recordFail(
          callId,
          { tool: "memory", action, readOnly: true },
          "[this is a read-only wake — memory can be searched and read here, but not written]",
        );
      }
      const facts = (params.facts ?? []).map((fact) => ({ id: fact.id?.trim() ?? "", text: fact.text.trim() }));
      try {
        switch (action) {
          case "search": {
            const query = params.query ?? "";
            if (!query.trim()) return fail("memory search requires `query`.");
            const hits = await tc.memorySearch(query, params.limit, params.scope);
            if (hits === null) return unavailable();
            return recordText(
              callId,
              { tool: "memory", action, query, count: hits.length },
              hits.length ? hits.join("\n") : `[no remembered facts match "${query}"]`,
            );
          }
          case "read": {
            const body = await tc.memoryRead(params.scope);
            if (body === null) return unavailable();
            return recordText(
              callId,
              { tool: "memory", action, chars: body.length },
              body.trim() ? body : "(you have nothing remembered here yet)",
            );
          }
          case "add": {
            const texts = facts.map((fact) => fact.text).filter(Boolean);
            if (!texts.length) return fail("memory add requires `facts` (a non-empty list of {text}).");
            const added = await tc.memoryAdd(texts);
            if (added === null) return unavailable();
            return recordText(
              callId,
              { tool: "memory", action, added },
              added
                ? `Remembered ${added} fact${added === 1 ? "" : "s"}.`
                : "Already remembered — nothing new to save.",
            );
          }
          case "edit": {
            if (!facts.length || facts.some((fact) => !fact.id || !fact.text))
              return fail("memory edit requires `facts` as a non-empty list of {id, text}.");
            if ((await tc.memoryEdit(facts)) === null) return unavailable();
            return recordText(
              callId,
              { tool: "memory", action, edited: facts.length },
              `Updated ${facts.length} fact${facts.length === 1 ? "" : "s"}.`,
            );
          }
          case "delete": {
            const ids = (params.ids ?? []).map((id) => id.trim()).filter(Boolean);
            if (!ids.length) return fail("memory delete requires `ids` (a non-empty list).");
            if ((await tc.memoryDelete(ids)) === null) return unavailable();
            return recordText(
              callId,
              { tool: "memory", action, deleted: ids.length },
              `Forgot ${ids.length} fact${ids.length === 1 ? "" : "s"}.`,
            );
          }
        }
      } catch (e) {
        if (e instanceof MemoryFactsMissing || e instanceof MemoryDisclosureDenied) return fail(e.message);
        throw e;
      }
    },
  });

  const history = defineTool({
    name: "history",
    label: "history",
    description:
      "Search or reopen THIS conversation's own durable transcript — past turns and tool calls, " +
      "including parts compacted out of your current context. Tool results are excluded. Use it when something " +
      'earlier in this conversation is referenced but not in front of you ("that file from last ' +
      'week", "what did we decide"). Distinct from `memory` search, which searches remembered facts ' +
      "across conversations; `history` searches only this one, verbatim. With `query`, matching is " +
      "case-insensitive, all terms must match, and the newest matching entries return, each tagged " +
      "kind#seq with its timestamp. With `seq`, the one entry with that seq returns in full — use it " +
      "to follow a kind#seq pointer from a search hit or an earlier-conversation summary.",
    parameters: Type.Object({
      query: optionalString("Words to look for in this conversation's transcript (all must match)."),
      seq: optionalInteger("Reopen the single entry with this seq in full, instead of searching."),
      limit: optionalInteger("Max entries to return (default 20, query mode only)."),
    }),
    async execute(callId, params) {
      const tc = ref.current;
      if (!tc) return text("[error] no active tool context");
      const seq = params.seq == null ? undefined : Number(params.seq);
      await recordCall(callId, {
        tool: "history",
        ...(params.query !== undefined ? { query: params.query } : {}),
        ...(seq !== undefined ? { seq } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      });
      if (seq !== undefined) {
        if (!Number.isInteger(seq)) {
          return recordFail(
            callId,
            { tool: "history", error: "seq must be an integer" },
            "[error] history `seq` must be an integer entry number, like the 87 in ToolCall#87.",
          );
        }
        const entry = await tc.historyOpen(seq);
        return recordText(
          callId,
          { tool: "history", seq, found: entry !== null },
          entry ?? `[no entry with seq ${seq} is visible in this conversation's transcript]`,
        );
      }
      if (!params.query?.trim()) {
        return recordFail(
          callId,
          { tool: "history", error: "query or seq required" },
          "[error] history requires `query` (words to search for) or `seq` (an entry to reopen).",
        );
      }
      const hits = await tc.history(params.query, params.limit);
      return recordText(
        callId,
        { tool: "history", query: params.query, count: hits.length },
        hits.length
          ? hits.map((h) => `- ${h}`).join("\n")
          : `[nothing in this conversation's transcript matches "${params.query}"]`,
      );
    },
  });
  return { memory, history };
}
