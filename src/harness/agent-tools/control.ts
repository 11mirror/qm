// The guidance tool, the sharing/resource tools (files, apps, skills, …) and the admin tool's action list.

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
  const { ref, recordCall, recordResult, recordText, recordFail, unavailable, isUnavailable } = kit;
  const guidance = defineTool({
    name: "guidance",
    label: "guidance",
    description:
      "Read or change your durable guidance — the standing instructions you carry into " +
      "future turns. Two scopes: `channel` = how you behave in THIS channel (when to chime " +
      "in unprompted, where replies land, ongoing 'whenever X, do Y' orders — evaluated " +
      "against every new message automatically, so never build a poll or timer for these); " +
      "`conversation` = your standing instructions for this conversation (tone, defaults, " +
      "recurring preferences). Default scope: `channel` when you're in a channel, else " +
      "`conversation`. Conversation guidance lives on the surrounding scope — in a personal " +
      "context it is shared by ALL of that person's sessions, not tied to the session that " +
      "wrote it. Never store session pins or 'for this session' notes here: ALL pinning goes " +
      "through the pins self-API (POST /v1/pins), which routes by context — the session's own " +
      "pins in the web UI, native pinning in Slack. `edit` swaps one exact passage `old` for `new` " +
      "and fails unless `old` appears exactly once in that scope's guidance; prefer it for small changes. " +
      "`replace` REPLACES that scope's entire guidance with `content` — include everything that " +
      "should remain. Org-wide policy is always layered above and " +
      "cannot be overridden. Don't store one-off facts here — that's what memory is for.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("read"), Type.Literal("replace"), Type.Literal("edit")]),
      scope: Type.Optional(Type.Union([Type.Literal("channel"), Type.Literal("conversation")])),
      content: optionalString("replace: the full new guidance for the scope."),
      old: optionalString("edit: an exact passage that appears once in the scope's current guidance."),
      new: optionalString("edit: the text that takes the place of `old`."),
      ambientEnabled: Type.Optional(
        Type.Union([Type.Boolean(), Type.Null()], {
          description:
            "Channel scope only. true judges every message for an unprompted reply, false responds only when addressed, and null uses the platform default.",
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
              "Per-bot handling for automated posters in this channel, keyed by bot author name: " +
              "ignore (never wakes you), rollup (batch; judge at most every rollupHours), action " +
              "(their posts are triggers to act on), user (treat like a person).",
          },
        ),
      ),
    }),
    async execute(callId, params) {
      const tc = ref.current;
      if (!tc) return text("[error] no active tool context");
      await recordCall(callId, {
        tool: "guidance",
        action: params.action,
        ...(params.scope ? { scope: params.scope } : {}),
      });

      const editError = (message: string) =>
        recordFail(callId, { tool: "guidance", scope, error: message }, `[error] guidance edit ${message}.`);
      const applyEdit = (current: string): { ok: true; next: string } | { ok: false; message: string } => {
        if (typeof params.old !== "string" || !params.old || typeof params.new !== "string")
          return { ok: false, message: "requires `old` (an exact passage of the current guidance) and `new`" };
        const at = current.indexOf(params.old);
        if (at < 0)
          return {
            ok: false,
            message:
              "found no exact match for `old` in this scope's own guidance; org policy layered above it cannot be edited",
          };
        if (current.indexOf(params.old, at + 1) >= 0)
          return { ok: false, message: "found `old` more than once; include more surrounding text so it is unique" };
        return { ok: true, next: current.slice(0, at) + params.new + current.slice(at + params.old.length) };
      };

      let scope = params.scope;
      let channel: Awaited<ReturnType<typeof tc.getStandingOrder>> | undefined;
      if (scope !== "conversation") {
        channel = await tc.getStandingOrder();
        if (!scope) scope = channel.ok ? "channel" : "conversation";
      }

      if (scope === "channel") {
        if (!channel!.ok) {
          return recordFail(
            callId,
            { tool: "guidance", scope, ok: false },
            "[no channel scope here; use scope=conversation]",
          );
        }
        if (params.action === "read") {
          const soul = tc.soulRead();
          const convoExists = !isUnavailable(soul) && !!soul.soul && soul.soul.trim().length > 0;
          const ledger =
            channel!.bots && Object.keys(channel!.bots).length
              ? "\n\nBot ledger:\n" +
                Object.entries(channel!.bots)
                  .map(([n, b]) => `- ${n}: ${b.mode}${b.rollupHours ? ` (every ${b.rollupHours}h)` : ""}`)
                  .join("\n")
              : "";
          const note = convoExists
            ? "\n\n(conversation-scope guidance also exists — read with scope=conversation)"
            : "";
          let ambientState = "default";
          if (channel!.ambientEnabled !== undefined) ambientState = channel!.ambientEnabled ? "on" : "off";
          const ambient = `\n\nAmbient replies: ${ambientState}`;
          const body =
            (channel!.orders.trim() ? channel!.orders : "[no channel guidance set]") + ambient + ledger + note;
          return recordText(callId, { tool: "guidance", scope, ok: true }, body);
        }
        let orders = typeof params.content === "string" ? params.content : undefined;
        if (params.action === "edit") {
          const edited = applyEdit(channel!.orders);
          if (!edited.ok) return editError(edited.message);
          orders = edited.next;
        } else if (typeof orders !== "string" && params.bots === undefined && params.ambientEnabled === undefined) {
          return recordFail(
            callId,
            { tool: "guidance", scope, error: "content, bots, or ambientEnabled required" },
            "[error] guidance replace needs `content` (the full new channel guidance), `bots`, and/or `ambientEnabled`.",
          );
        }
        const r = await tc.setStandingOrder(
          orders,
          params.bots,
          params.ambientEnabled,
          params.action === "edit" ? channel!.orders : undefined,
        );
        if (!r.ok) return recordFail(callId, { tool: "guidance", scope, ok: false }, `[error] ${r.message}`);
        return recordText(callId, { tool: "guidance", scope, ok: true }, "[channel guidance updated]");
      }

      if (params.ambientEnabled !== undefined) {
        return recordFail(
          callId,
          { tool: "guidance", scope, error: "ambientEnabled is channel scope only" },
          "[error] `ambientEnabled` applies only to channel scope.",
        );
      }

      if (params.action === "read") {
        const r = tc.soulRead();
        if (isUnavailable(r)) return unavailable(callId, "guidance");
        return recordText(
          callId,
          { tool: "guidance", scope, soulVersion: r.soulVersion },
          r.soul ? r.soul : "(no standing instructions set)",
        );
      }
      let content = params.content;
      let expectedVersion: number | undefined;
      if (params.action === "edit") {
        const current = tc.soulRead();
        if (isUnavailable(current)) return unavailable(callId, "guidance");
        const edited = applyEdit(current.soul ?? "");
        if (!edited.ok) return editError(edited.message);
        content = edited.next;
        expectedVersion = current.soulVersion;
      } else if (typeof content !== "string") {
        return recordFail(
          callId,
          { tool: "guidance", scope, error: "content required" },
          "[error] guidance replace requires `content` (the full new standing instructions).",
        );
      }
      const r = await tc.soulWrite(content, expectedVersion);
      if (isUnavailable(r)) return unavailable(callId, "guidance");
      if (!r.ok) return recordFail(callId, { tool: "guidance", scope, error: r.code }, `[error] ${r.message}`);
      return recordText(
        callId,
        { tool: "guidance", scope, version: r.version },
        `Updated your standing instructions (now version ${r.version}).`,
      );
    },
  });

  function sharingTool(type: "file" | "skill" | "deploy" | "cron", move = false): ToolDefinition {
    const tool = { file: "files", skill: "skills", deploy: "apps", cron: "cron" }[type];
    const action = move ? "move" : "share";
    let description =
      "Grant access to an artifact you own while keeping it in its current home. Only the owner can share; grantees cannot reshare.";
    if (type === "file")
      description =
        "Share an existing Files record by ID. A sandbox path cannot be shared; upload it with POST /v1/files/uploads first.";
    if (move)
      description =
        "Transfer the artifact to another context. Moving an app transfers ownership; existing shares survive. Moving a skill to the org requires an org admin in a user-started turn.";
    else if (type === "deploy")
      description =
        "Change access to an app you own while keeping it in its current home. Set public to true or false for anonymous link access, or use toScope/email for authenticated access (external emails are view-only). Only the owner can share; grantees cannot reshare.";
    return defineTool({
      name: action,
      label: action,
      description,
      parameters: Type.Object({
        id: Type.String({
          description:
            "Artifact ID (for a skill, the id from skills list or search); an app may also be named by its handle.",
        }),
        toScope:
          type === "deploy" && !move
            ? optionalString(
                'Authenticated destination: "org", channel:<id>, team:<id>, personal:<id>, or a teammate name. Omit when setting public or email.',
              )
            : Type.String({
                description: 'Destination: "org", channel:<id>, team:<id>, personal:<id>, or a teammate name.',
              }),
        ...(type === "deploy" && !move
          ? {
              email: optionalString(
                "Exact email to grant view access, including people outside the directory. Use instead of toScope.",
              ),
              public: optionalBoolean(
                "true lets anyone with the link open the app without signing in; false makes it restricted again. Never enabled by default.",
              ),
            }
          : {}),
        ...(!move
          ? {
              permission: Type.Optional(
                Type.Union([Type.Literal("read"), Type.Literal("write")], {
                  description: "read = view/use (default); write = view/manage.",
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
        .map(
          ({ actions, operation }) =>
            `${actions.join("/")}: ${operation.description} Required fields: ${((operation.parameters as { required?: string[] }).required ?? []).filter((key) => key !== "action").join(", ") || "none"}.`,
        )
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

  const adminActions: Record<string, ToolDefinition> = Object.fromEntries(
    Object.entries(adminOperations).map(([action, operation]) => [
      action,
      defineTool({
        name: action,
        label: action,
        description: operation.description,
        parameters: operation.parameters,
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
      }),
    ]),
  );

  const adminPreamble =
    "Uses existing admin handlers and audit. Authority is rechecked on every call. Private content requires a live admin in a DM or Open conversation; unattended reads require explicit grants. Admin-role changes, impersonation, identity links, and teammate invitations are portal-only. Confirm every mutation, report exactly what changed, and disclose only what this conversation needs. Binary/full captured-prompt downloads and raw-secret setters remain on the self-API; do not put secrets in native arguments.\n\n";
  return { guidance, sharingTool, resourceTool, adminActions, adminPreamble };
}
