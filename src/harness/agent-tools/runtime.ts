// The context and runtime tools: compacting this conversation's context and switching model, effort or fast mode.

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isObj } from "../../util/objects.ts";
import { goalIsOpen } from "../goal.ts";
import type { RuntimeRequest } from "../runtime-types.ts";
import { type ToolKit } from "./kit.ts";
import { optionalString, text } from "./shared.ts";

export function runtimeTools(kit: ToolKit) {
  const { ref, opts, recordCall, recordCoreAuthoredResult } = kit;
  const context = defineTool({
    name: "context",
    label: "context",
    description:
      "Reduce this conversation's model context without calling a summarizer. compact with mode recent keeps bounded recent entries, a saved summary if it fits, and structured goal state. Stored history is not deleted. This stops the current segment and resumes the unfinished request; do not repeat completed actions. Call this by itself after other tools finish.",
    parameters: Type.Object({ action: Type.Literal("compact"), mode: Type.Literal("recent") }),
    async execute(callId, params) {
      await recordCall(callId, { tool: "context", ...params });
      const result = await recordCoreAuthoredResult(
        callId,
        { tool: "context", ...params, ok: true },
        {
          ...text("Recent-context recovery requested. Continue from recorded results after the context is reduced."),
          terminate: true,
        },
      );
      ref.runtimeHandoff = { context: "recent" };
      return result;
    },
  });

  const runtime = defineTool({
    name: "runtime",
    label: "runtime",
    description:
      "Inspect or change your model, reasoning effort, and fast mode. Use get to see the actual active runtime, saved defaults, and available choices. Use set for requests such as 'switch to Astra and do this'. A successful change stops this runtime and resumes the unfinished task on the selected runtime with saved tool results. Omitted settings are preserved. lifetime defaults to task (this user request or cron fire, including retries); scope changes the default for future requests in this scope too and requires a live user. Cron fires may change only their task runtime; the next fire keeps its configured runtime. inherit returns to the scope default, or clears the scope override when lifetime is scope. Never guess capabilities or claim you cannot switch before using this tool. Call a change by itself, after other tools finish.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("get"), Type.Literal("set"), Type.Literal("inherit")]),
      model: optionalString("Model ID or exact display name from get, such as Astra."),
      effort: optionalString(
        "Use modelCatalog[modelId].effortLevels from get. adaptive = native Auto; default = provider default; auto = legacy default, not adaptive reasoning.",
      ),
      fastMode: Type.Optional(Type.Boolean()),
      lifetime: Type.Optional(Type.Union([Type.Literal("task"), Type.Literal("scope")])),
    }),
    async execute(callId, params) {
      const request = params as RuntimeRequest;
      await recordCall(callId, { tool: "runtime", ...request });
      if (request.action !== "get" && goalIsOpen(ref.goal)) {
        return recordCoreAuthoredResult(
          callId,
          { tool: "runtime", error: "goal_in_progress" },
          text(
            "Runtime changes are unavailable while a goal or work floor is unfinished. Continue the goal on the current runtime.",
          ),
          true,
        );
      }
      const result =
        opts?.readOnly && request.action !== "get"
          ? { ok: false as const, error: "read_only" }
          : ((await ref.current?.runtime?.(request, ref.abortSignal)) ?? { ok: false, error: "runtime_unavailable" });
      const handoff = result.ok ? result.handoff : undefined;
      const ret = await recordCoreAuthoredResult(
        callId,
        {
          tool: "runtime",
          action: request.action,
          ok: result.ok,
          ...(handoff ? { runtimeHandoff: handoff, actorId: ref.runtimeActorId } : {}),
          ...(result.ok && request.action === "get" && isObj(result.active) ? { runtimeActive: result.active } : {}),
        },
        { ...text(JSON.stringify(result)), ...(handoff ? { terminate: true } : {}) },
        !result.ok,
      );
      if (handoff) ref.runtimeHandoff = handoff;
      return ret;
    },
  });
  return { context, runtime };
}
