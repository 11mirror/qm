import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import { Check } from "typebox/value";
import { redactSecrets } from "../../../plugins/chassis/src/redact-secrets.ts";
import { splitToScope } from "../../api/artifact-share.ts";
import { BOT_MODES } from "../../surface-cache/channel-policy-store.ts";
import { adminOperations } from "../../tools/admin.ts";
import { errMessage } from "../../util/errors.ts";
import { type ToolKit } from "./kit.ts";
import { optionalBoolean, optionalString, text } from "./shared.ts";

export function controlPlaneTools(kit: ToolKit) {
  const { instructionsTool } = instructionsToolFor(kit);
  const { sharingTool } = sharingTools(kit);
  const { resourceTool, adminTool } = resourceTools(kit);
  return { instructionsTool, sharingTool, resourceTool, adminTool };
}

function instructionsToolFor(kit: ToolKit) {
  const { ref, recordCall, recordText, recordFail, unavailable, isUnavailable } = kit;
  const instructionsTool = defineTool({
    name: "instructions",
    label: "instructions",
    description:
      "Read or change your standing instructions for this conversation's scope: tone, defaults, preferences and 'whenever X, do Y' orders; they are the conversation instructions in your prompt. " +
      "In a channel they are checked against every message, so never build a poll or timer for them; in a personal context all of that person's sessions share them. " +
      "Not for session pins (POST /v1/pins) or one-off facts (memory). " +
      "edit swaps one exact passage `old` for `new`; replace overwrites the whole text with `content`. Organization instructions sit above and cannot be changed here.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("read"), Type.Literal("replace"), Type.Literal("edit")]),
      content: optionalString("replace: the full instructions."),
      old: optionalString("edit: exact passage appearing once."),
      new: optionalString("edit: replacement for `old`."),
      ambientEnabled: Type.Optional(
        Type.Union([Type.Boolean(), Type.Null()], {
          description:
            "Channel only. true: judge every message for a reply; false: only when addressed; null: default.",
        }),
      ),
      bots: Type.Optional(
        Type.Record(
          Type.String(),
          Type.Object({
            mode: Type.Union(BOT_MODES.map((m) => Type.Literal(m))),
            rollupHours: Type.Optional(Type.Number()),
          }),
          {
            description:
              "Channel only, per bot author name: ignore, rollup (judge at most every rollupHours), action (posts are triggers), user (treat like a person).",
          },
        ),
      ),
    }),
    async execute(callId, params) {
      const tc = ref.current;
      if (!tc) return text("[error] no active tool context");
      await recordCall(callId, { tool: "instructions", action: params.action });
      const fail = (error: string, message: string) =>
        recordFail(callId, { tool: "instructions", error }, `[error] ${message}`);
      const channel = await tc.getChannelBehavior();

      if (params.action === "read") {
        const r = tc.instructionsRead();
        if (isUnavailable(r)) return unavailable(callId, "instructions");
        let body = r.instructions?.trim() ? r.instructions : "(no instructions set)";
        if (channel.ok) {
          let ambientState = "default";
          if (channel.ambientEnabled !== undefined) ambientState = channel.ambientEnabled ? "on" : "off";
          body += `\n\nAmbient replies: ${ambientState}`;
          if (channel.bots && Object.keys(channel.bots).length)
            body +=
              "\n\nBot ledger:\n" +
              Object.entries(channel.bots)
                .map(([n, b]) => `- ${n}: ${b.mode}${b.rollupHours ? ` (every ${b.rollupHours}h)` : ""}`)
                .join("\n");
        }
        return recordText(callId, { tool: "instructions", version: r.instructionsVersion }, body);
      }

      const behaviorChange = params.bots !== undefined || params.ambientEnabled !== undefined;
      if (behaviorChange && !channel.ok)
        return fail("channel_only", "`ambientEnabled` and `bots` apply only in a channel.");
      let content = params.content;
      let expectedVersion: number | undefined;
      if (params.action === "edit") {
        if (typeof params.old !== "string" || !params.old || typeof params.new !== "string")
          return fail(
            "edit_args",
            "instructions edit requires `old` (an exact passage of the current instructions) and `new`.",
          );
        const current = tc.instructionsRead();
        if (isUnavailable(current)) return unavailable(callId, "instructions");
        const existing = current.instructions ?? "";
        const at = existing.indexOf(params.old);
        if (at < 0)
          return fail(
            "edit_no_match",
            "instructions edit found no exact match for `old`; organization instructions layered above cannot be edited.",
          );
        if (existing.indexOf(params.old, at + 1) >= 0)
          return fail(
            "edit_ambiguous",
            "instructions edit found `old` more than once; include more surrounding text so it is unique.",
          );
        content = existing.slice(0, at) + params.new + existing.slice(at + params.old.length);
        expectedVersion = current.instructionsVersion;
      } else if (typeof content !== "string" && !behaviorChange) {
        return fail(
          "content_required",
          "instructions replace needs `content` (the full new instructions), or `bots` / `ambientEnabled` in a channel.",
        );
      }
      if (behaviorChange) {
        const r = await tc.setChannelBehavior(params.bots, params.ambientEnabled);
        if (!r.ok) return fail("channel_settings", r.message);
      }
      if (typeof content !== "string")
        return recordText(callId, { tool: "instructions", ok: true }, "[channel settings updated]");
      const r = await tc.instructionsWrite(content, expectedVersion);
      if (isUnavailable(r)) return unavailable(callId, "instructions");
      if (!r.ok) return fail(r.code, r.message);
      return recordText(
        callId,
        { tool: "instructions", version: r.version },
        `Updated your instructions (now version ${r.version}).`,
      );
    },
  });
  return { instructionsTool };
}

const ARTIFACT_ID_DESCRIPTIONS = {
  file: "Artifact ID.",
  skill: "Skill id from skills list or search.",
  deploy: "App ID or handle.",
  cron: "Artifact ID.",
};

function sharingTools(kit: ToolKit) {
  const { ref, recordCall, recordText, recordFail, unavailable, isUnavailable } = kit;
  function sharingTool(type: "file" | "skill" | "deploy" | "cron", move = false): ToolDefinition {
    const tool = { file: "files", skill: "skills", deploy: "apps", cron: "cron" }[type];
    const action = move ? "move" : "share";
    let description = "Grant access to an artifact you own; grantees cannot reshare.";
    if (type === "file")
      description = "Share a Files record by ID (upload a sandbox path with POST /v1/files/uploads first).";
    if (move)
      description =
        "Move to another context; moving an app transfers ownership; shares survive. Moving a skill to the org needs an org admin on a user-started turn.";
    else if (type === "deploy")
      description =
        "Change access to an app you own: `public`, or toScope/email for signed-in access (external emails view-only).";
    return defineTool({
      name: action,
      label: action,
      description,
      parameters: Type.Object({
        id: Type.String({ description: ARTIFACT_ID_DESCRIPTIONS[type] }),
        toScope:
          type === "deploy" && !move
            ? optionalString('"org", channel:<id>, team:<id>, personal:<id>, or a teammate name.')
            : Type.String({
                description: '"org", channel:<id>, team:<id>, personal:<id>, or a teammate name.',
              }),
        ...(type === "deploy" && !move
          ? {
              email: optionalString("Email granted view access; alternative to toScope."),
              public: optionalBoolean("true: anyone with the link; false: restricted."),
            }
          : {}),
        ...(!move
          ? {
              permission: Type.Optional(
                Type.Union([Type.Literal("read"), Type.Literal("write")], {
                  description: "read (default) or write (manage).",
                }),
              ),
            }
          : {}),
      }),
      async execute(callId, args) {
        const params = args as {
          id: string;
          toScope?: string;
          email?: string;
          public?: boolean;
          permission?: "read" | "write";
        };
        const tc = ref.current;
        if (!tc) return text("[error] no active tool context");
        const id = params.id;
        await recordCall(callId, { tool, action, type, id });
        if (type === "deploy" && !move && params.public !== undefined) {
          if (params.toScope !== undefined || params.email !== undefined)
            return recordFail(
              callId,
              { tool, action, error: "bad_request" },
              "[error] set public, email, or toScope, not more than one",
            );
          const d = await tc.setDeploymentPublic(id, params.public);
          return recordText(
            callId,
            { tool, action, type, id: d.id, public: d.public },
            `${d.name ?? d.id} is now ${d.public ? "public — anyone with the link can open it" : "restricted"}.`,
          );
        }
        if (!params.toScope && !params.email)
          return recordFail(
            callId,
            { tool, action, error: "bad_request" },
            "[error] toScope or email is required unless public is set",
          );
        const r = await tc.shareArtifact({
          type,
          id,
          ...(params.toScope ? splitToScope(params.toScope) : {}),
          ...(params.email !== undefined ? { email: params.email } : {}),
          ...(params.permission !== undefined ? { permission: params.permission } : {}),
          ...(move ? { move: true } : {}),
        });
        if (isUnavailable(r)) return unavailable(callId, tool);
        if (!r.ok) {
          const candidates = r.candidates?.length
            ? `\nCandidates: ${r.candidates.map((c) => `${c.label} (${c.id})`).join(", ")}`
            : "";
          return recordFail(callId, { tool, action, error: r.code }, `[error] ${r.message}${candidates}`);
        }
        let invitationNote = "";
        if (r.invitation) {
          if (r.invitation.emailSent) invitationNote = " App invitation email sent.";
          else if (r.invitation.alreadyShared) invitationNote = " Already shared; no duplicate email sent.";
          else
            invitationNote = ` Access granted, but invitation email was not sent: ${r.invitation.emailProblem ?? "delivery unavailable"}`;
          if (r.invitation.appUrl) invitationNote += ` App link: ${r.invitation.appUrl}`;
        }
        return recordText(
          callId,
          { tool, action, verb: r.verb, type: r.type, id: r.id, target: r.target.scope },
          `${r.verb === "move" ? "Moved" : "Shared"} ${r.type} ${r.id} → ${r.target.label}${r.verb === "share" ? ` (${r.permission})` : ""}.${invitationNote}`,
        );
      },
    });
  }
  return { sharingTool };
}

const ADMIN_PREAMBLE =
  "Admin API; authority is rechecked on every call and audited. Private content needs a live admin in a DM or on a turn they started; unattended reads need explicit grants. Admin-role changes, impersonation, identity links and teammate invitations are portal-only. Confirm every mutation, report exactly what changed, and disclose only what this conversation needs. Never put secrets in arguments.\n\n";

function requiredSuffix(operation: ToolDefinition): string {
  const required = ((operation.parameters as { required?: string[] }).required ?? []).filter((key) => key !== "action");
  return required.length ? ` Requires ${required.join(", ")}.` : "";
}

function resourceTools(kit: ToolKit) {
  const { ref, recordCall, recordResult, recordFail } = kit;
  function resourceTool(name: string, actions: Record<string, ToolDefinition>): ToolDefinition {
    const groups = [...new Set(Object.values(actions))].map((operation) => ({
      operation,
      actions: Object.keys(actions).filter((action) => actions[action] === operation),
    }));
    const variants = groups.map((group) => ({
      ...group.operation.parameters,
      ...Type.Object(
        {
          ...(group.operation.parameters as { properties: Record<string, TSchema> }).properties,
          action: Type.Union(group.actions.map((action) => Type.Literal(action))),
        },
        { additionalProperties: false },
      ),
    }));
    const properties: Record<string, TSchema> = {};
    for (const variant of variants) {
      for (const [key, schema] of Object.entries(variant.properties)) properties[key] = Type.Optional(schema);
    }
    properties.action = Type.Union(Object.keys(actions).map((action) => Type.Literal(action)));
    return defineTool({
      name,
      label: name,
      description: groups
        .map(({ actions, operation }) => `${actions.join("/")}: ${operation.description}${requiredSuffix(operation)}`)
        .join("\n\n"),
      parameters: Type.Object(properties, { additionalProperties: true }),
      async execute(callId, params, signal, onUpdate, ctx) {
        const index = groups.findIndex((group) => group.actions.includes(String(params.action)));
        if (index < 0 || !Check(variants[index]!, params)) {
          return recordFail(
            callId,
            { tool: name, action: params.action, error: "invalid_arguments" },
            `[error] Invalid arguments for ${name} action ${String(params.action)}. ${groups[index]?.operation.description ?? ""}`,
          );
        }
        return actions[String(params.action)]!.execute(callId, params, signal, onUpdate, ctx);
      },
    });
  }

  const adminAction = (action: keyof typeof adminOperations): ToolDefinition =>
    defineTool({
      name: action,
      label: action,
      description: adminOperations[action].description,
      parameters: adminOperations[action].parameters,
      async execute(callId, params) {
        await recordCall(callId, { tool: "admin", action });
        try {
          const result = await ref.current?.admin?.call({ ...params, action }, ref.abortSignal);
          if (!result) throw new Error("Admin API is not available on this turn");
          return recordResult(
            callId,
            { tool: "admin", action, status: result.status },
            {
              ...text(result.status >= 400 ? redactSecrets(JSON.stringify(result)) : JSON.stringify(result)),
              isError: result.status >= 400,
            },
            result.status >= 400,
          );
        } catch (error) {
          return recordResult(
            callId,
            { tool: "admin", action, error: redactSecrets(errMessage(error)) },
            { ...text(redactSecrets(errMessage(error))), isError: true },
            true,
          );
        }
      },
    });

  function adminTool(actions: readonly string[], operationsAvailable: boolean): ToolDefinition {
    const tool = resourceTool(
      "admin",
      Object.fromEntries(actions.map((action) => [action, adminAction(action as keyof typeof adminOperations)])),
    );
    if (operationsAvailable) tool.description = ADMIN_PREAMBLE + tool.description;
    return tool;
  }
  return { resourceTool, adminTool };
}
