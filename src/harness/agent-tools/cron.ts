// The cron and webhook tools: scheduled and inbound-event work.

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CRON_FIRE_NOTE_MAX_CHARS, UNATTENDED_ADMIN_GRANTS } from "../../api/control-service.ts";
import { utcMinute } from "../../util/time.ts";
import { WEBHOOK_SCHEMES } from "../../webhooks/verifiers.ts";
import { type ToolKit } from "./kit.ts";
import {
  CRON_ID_ACTIONS,
  fmtCronCreated,
  fmtCronLine,
  fmtCronRunLine,
  listOrder,
  optionalBoolean,
  optionalInteger,
  optionalString,
  pageOf,
  previewText,
  previewTrims,
  SENDER_WEBHOOK_SCHEMES,
  text,
  WEBHOOK_ACTION_PREVIEW_CHARS,
} from "./shared.ts";

export function schedulingTools(kit: ToolKit) {
  const { ref, recordCall, recordResult, recordText, recordFail, refused, unavailable, isUnavailable } = kit;
  const cron = defineTool({
    name: "cron",
    label: "cron",
    description:
      "Schedule future or recurring work, and manage what you've scheduled. ALWAYS confirm the timing " +
      "with the user before you create a schedule. ONE recurring job = ONE cron: before creating, " +
      "action=list and if a cron for this job already exists, action=patch it in place — never create a " +
      "second.\n" +
      "action=create schedules it. Always set a `title`: a 2-5 word label naming what the cron is FOR " +
      '(e.g. "Gmail unread digest", "GitLab CI watch", "DoorDash retry") — not the command it runs, ' +
      'not a generic word like "Run" or "First". It sits in a list next to the owner\'s other crons, ' +
      'so make it distinctive and scannable. Provide EITHER `task` (a prompt re-evaluated at fire time — "check Gmail and ' +
      'summarize anything notable; if nothing changed, call finish_silently") OR `text` (exact words to send ' +
      "verbatim, a reminder/relay), not both. `schedule` is one of: {cron,timezone} for calendar times " +
      "(`cron` is a 5-field expression `minute hour day-of-month month day-of-week`; `timezone` is an IANA " +
      'name like "America/Los_Angeles" — if the user gave a local time use the timezone from "The user\'s ' +
      "local time\" unless they name another; omit to use this turn's timezone — do NOT compute future epochs " +
      "for daily/weekly/monthly). DEFAULT to {cron,timezone} for anything that should happen at a time of day " +
      "or on a calendar (digests, reminders, reports) — think about the timezone and the actual helpful hour. " +
      "{everyMs} is ONLY for genuine sub-day polling where wall-clock time does not matter (first run one " +
      "interval from now, not immediately; an everyMs of 24h+ is rejected — use {cron,timezone} instead), or " +
      '{firstFireAt} (epoch ms; fires once then auto-cancels — use Date.now() for "send now").\n' +
      "DELIVERY: by default a cron posts back to this conversation — the surface where you are talking now (a web session, Slack DM, or thread). " +
      "Keep that default for watches and follow-ups on work started here (including delegated sessions) unless the person names another destination; don't pick a DM just because it is a DM. " +
      "The only other destination is a named Slack target: set `recipient` " +
      "(a teammate's name → a DM; core resolves the name and the result echoes who it matched) or `channel` " +
      "(a channel name → that channel). Don't bury \"send this to Slack\" inside `task`. A cron's destination is fixed at create; " +
      "to move one, create the new cron and delete the old. Pass unfurlLinks=false when Slack should not show link previews for the delivered message.\n" +
      "ACCESS — a cron belongs to whoever creates it and runs as them, with what its conversation has been granted " +
      "plus, where they share Open with it, their own keychain. Everyone in the conversation " +
      "can see it; only its owner can change it unless they share write access (action=share, permission=write). " +
      "If the owner leaves the conversation, the cron is deleted.\n" +
      'A cron whose fires read admin data (admin tool or API) needs `unattendedGrants`, and many admin reads have none: before creating it, follow the admin skill\'s "Scheduling admin-reading work", which fetches the live grant list.\n' +
      "action=list pages through your crons (and ones visible through shared scopes), 25 per page — enabled first, " +
      "newest first, long task text trimmed; when there's more, a footer line names the offset for the next page. " +
      "action=get inspects one in full; " +
      "action=runs reads the retained fire log when a fresh run needs older history — fires appear the moment " +
      'they start (status "running", updated with the outcome when they end), so an empty-looking log never ' +
      "means nothing is running; " +
      "action=patch edits IN PLACE (rename via `title`, change `schedule`/`task`/`text`, `enabled:false` " +
      "pauses, `enabled:true` resumes, `archived:true` archives). `task` is the standing instructions every " +
      "fire receives — patch it only to change what future fires are told to do; durable run-state (notes, " +
      "workarounds, checkpoints a future fire needs) belongs in this conversation's durable Files via the available Files API, not in " +
      "`task` or only on sandbox disk. Confirm publication succeeds, use a cron-specific filename, and leave the file ID in action=note for retrieval with GET /v1/files/:id/content. Small progress state can live directly in the note; never store credentials there. If publication is unavailable, report it and retain needed local state on a scoped computer. Keep tasks that need existing workspace files on that computer until their state has been migrated and verified. action=delete removes it for good; " +
      "action=run fires it once now (no effect on a paused cron) and is refused while a fire of that cron is " +
      "still running — repeating it never double-fires; action=disable pauses it.\n" +
      "action=note (id + note, running inside a cron fire) leaves a short shift-change note the NEXT fire " +
      `reads before it starts — one or two sentences, max ${CRON_FIRE_NOTE_MAX_CHARS} chars: the outcome plus ` +
      "anything the next fire must know. It overwrites the previous fire's note.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("create"),
          Type.Literal("list"),
          Type.Literal("get"),
          Type.Literal("runs"),
          Type.Literal("patch"),
          Type.Literal("delete"),
          Type.Literal("run"),
          Type.Literal("disable"),
          Type.Literal("note"),
        ],
        {
          description:
            "create a cron, list yours, get/runs/patch/delete one by id, run one now, disable (pause) one, or note — leave a short shift-change note for its next fire.",
        },
      ),
      id: optionalString("get/runs/patch/delete/run/disable/note only: the cron id."),
      title: optionalString(
        'create/patch: a 2-5 word label naming what the cron is FOR (e.g. "Gmail unread digest"), distinctive and scannable — not the command, not a generic word like "Run"/"First". Always set one.',
      ),
      schedule: Type.Optional(
        Type.Object(
          {
            cron: optionalString("5-field cron expression: minute hour day-of-month month day-of-week."),
            timezone: optionalString('IANA timezone for a cron schedule, e.g. "America/Los_Angeles".'),
            everyMs: optionalInteger(
              "recurring interval in ms, for sub-day polling only; first run one interval from now. For daily/weekly/monthly or any time-of-day run use {cron,timezone} instead — everyMs >= 24h is rejected (it has no timezone and drifts with DST).",
            ),
            firstFireAt: optionalInteger(
              "epoch ms for a one-shot (fires once, then auto-cancels); a time in the past is rejected.",
            ),
          },
          { description: "create/patch: when it runs — {cron,timezone} | {everyMs} | {firstFireAt}." },
        ),
      ),
      task: optionalString("create/patch: a prompt re-evaluated at fire time (a dynamic task). Use this OR text."),
      text: optionalString("create/patch: exact words to send verbatim (a reminder/relay). Use this OR task."),
      recipient: optionalString("create: a teammate's name to DM (core resolves it; you can't author a raw address)."),
      channel: optionalString("create: a channel name to post to (core resolves it)."),
      session: optionalBoolean(
        "create/patch: tie the cron to this conversation so it shows as ongoing work here. Created crons are tied by default; pass false to leave it untied, or patch true/false to tie or untie it.",
      ),
      unfurlLinks: optionalBoolean(
        "create/patch: Slack-only delivery option. false suppresses link/media previews; omit to keep the default or existing setting.",
      ),
      note: Type.Optional(
        Type.String({
          maxLength: CRON_FIRE_NOTE_MAX_CHARS,
          description:
            `note only: the shift-change note for the cron's next fire — one or two sentences (max ${CRON_FIRE_NOTE_MAX_CHARS} chars): ` +
            "outcome + anything the next fire must know. Overwrites the previous note.",
        }),
      ),
      runtime: Type.Optional(
        Type.Union(
          [
            Type.Null(),
            Type.Object({
              modelId: Type.String(),
              effortLevel: Type.Optional(Type.String()),
              fastMode: Type.Optional(Type.Boolean()),
            }),
          ],
          {
            description:
              "create/patch: optional runtime override for an agent task. Omit to preserve defaults; null clears an override. Use runtime get to discover approved models. Choose a cheaper model and explicit low effort when the whole task, including failure handling, is simple. Unavailable choices fail closed. Auto effort is not supported here yet.",
          },
        ),
      ),
      unattendedGrants: Type.Optional(
        Type.Array(Type.Union(UNATTENDED_ADMIN_GRANTS.map((grant) => Type.Literal(grant))), {
          description:
            "create/patch: read-only admin grants for this cron's fires (org admins only; the cron must live in and deliver to their own DM); the admin tool's unattended_grants action lists which read needs which. patch replaces; [] removes.",
        }),
      ),
      inbox: optionalBoolean(
        "create: give the cron an inbox, a durable queue of work items each fire reads, adds to and closes at $AGENT_API_URL/v1/crons/<id>/items.",
      ),
      enabled: optionalBoolean("patch only: false pauses the cron, true resumes it."),
      archived: optionalBoolean("patch only: true archives the cron."),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          description:
            "list: page size (default 25, max 100). runs: return only the latest N retained fire log entries; omit for all retained entries.",
        }),
      ),
      offset: Type.Optional(
        Type.Integer({
          minimum: 0,
          description: "list only: start the page here — pass the offset the previous page's footer names to continue.",
        }),
      ),
    }),
    async execute(callId, params) {
      const tc = ref.current;
      if (!tc) return text("[error] no active tool context");
      await recordCall(callId, { tool: "cron", action: params.action, ...(params.id ? { id: params.id } : {}) });
      const id = typeof params.id === "string" ? params.id : "";
      const fail = (error: string, message: string) =>
        recordFail(callId, { tool: "cron", error }, `[error] ${message}`);
      if (CRON_ID_ACTIONS.has(params.action) && !id)
        return fail("id required", `cron ${params.action} requires \`id\`.`);
      switch (params.action) {
        case "create": {
          if (!params.schedule)
            return fail(
              "schedule required",
              "cron create requires `schedule` ({cron,timezone} | {everyMs} | {firstFireAt}).",
            );
          if (params.task === undefined && params.text === undefined) {
            return fail("task or text required", "cron create requires `task` (a prompt) or `text` (exact words).");
          }
          const r = await tc.cronCreate({
            schedule: params.schedule,
            ...(params.runtime !== undefined ? { runtime: params.runtime } : {}),
            ...(params.title !== undefined ? { title: params.title } : {}),
            ...(params.task !== undefined ? { action: params.task } : {}),
            ...(params.text !== undefined ? { text: params.text } : {}),
            ...(params.recipient !== undefined ? { recipient: params.recipient } : {}),
            ...(params.channel !== undefined ? { channel: params.channel } : {}),
            ...(params.unfurlLinks !== undefined ? { unfurlLinks: params.unfurlLinks } : {}),
            ...(params.session !== undefined ? { session: params.session } : {}),
            ...(params.unattendedGrants !== undefined ? { unattendedGrants: params.unattendedGrants } : {}),
            ...(params.inbox === true ? { inbox: true } : {}),
          });
          if (isUnavailable(r)) return unavailable(callId, "cron");
          if (!r.ok) {
            const cand = r.candidates?.length
              ? `\nCandidates: ${r.candidates.map((c) => `${c.label} (${c.id})`).join(", ")}`
              : "";
            return fail(r.code, `${r.message}${cand}`);
          }
          return recordText(
            callId,
            {
              tool: "cron",
              id: r.cron.id,
              created: true,
              ...(r.recipient ? { recipient: r.recipient } : {}),
              ...(r.channel ? { channel: r.channel } : {}),
            },
            fmtCronCreated(r),
          );
        }
        case "list": {
          const r = await tc.cronList();
          if (isUnavailable(r)) return unavailable(callId, "cron");
          const items = [
            ...r.crons.map((c) => ({ c, prefix: "" })),
            ...r.visible.map((c) => ({ c, prefix: `(read-only, ${c.scopeName ?? c.ownerScopeId}) ` })),
          ].sort((a, b) => listOrder(a.c, b.c));
          if (!items.length)
            return recordText(callId, { tool: "cron", count: 0, visible: 0 }, "(no crons scheduled here)");
          const { page, offset, note } = pageOf(items, params);
          const trimmed = page.some(({ c }) => previewTrims(c.action || c.message));
          const lines = page.map(({ c, prefix }) => `- ${prefix}${fmtCronLine(c, true)}`);
          const footer = [note, trimmed ? "task text is trimmed — action=get shows a cron in full" : null]
            .filter(Boolean)
            .join("; ");
          return recordResult(
            callId,
            {
              tool: "cron",
              count: r.crons.length,
              visible: r.visible.length,
              shown: page.length,
              ...(offset > 0 ? { offset } : {}),
            },
            text([...lines, ...(footer ? [`(${footer})`] : [])].join("\n")),
            false,
            { screenAs: r.visible.length ? { provenance: "external", source: "shared crons" } : undefined },
          );
        }
        case "get": {
          const r = await tc.cronGet(id);
          if (!r.ok) return refused(callId, "cron", r);
          return recordResult(callId, { tool: "cron", id }, text(fmtCronLine(r.cron)), false, {
            screenAs: {
              provenance: "external",
              source: "shared crons",
            },
          });
        }
        case "runs": {
          const r = await tc.cronRuns(id, params.limit !== undefined ? { limit: params.limit } : undefined);
          if (!r.ok) return refused(callId, "cron", r);
          const lines = r.runs.map(fmtCronRunLine);
          const suffix =
            r.runs.length === r.total
              ? ""
              : `\n(showing ${r.runs.length} of ${r.total}; omit limit for all retained entries)`;
          const noteLine =
            r.cron.lastFireNote && Number.isFinite(r.cron.lastFireNote.at)
              ? `\n(shift-change note (${utcMinute(r.cron.lastFireNote.at)}${r.cron.lastFireNote.by ? `, by ${r.cron.lastFireNote.by}` : ""}): ${r.cron.lastFireNote.text})`
              : "";
          return recordResult(
            callId,
            { tool: "cron", id, count: r.runs.length, total: r.total },
            text(lines.length ? `${lines.join("\n")}${suffix}${noteLine}` : "(no recorded fires for this cron)"),
            false,
            { screenAs: { provenance: "external", source: "shared crons" } },
          );
        }
        case "patch": {
          const r = await tc.cronPatch(id, {
            ...(params.runtime !== undefined ? { runtime: params.runtime } : {}),
            ...(params.title !== undefined ? { title: params.title } : {}),
            ...(params.task !== undefined ? { action: params.task } : {}),
            ...(params.text !== undefined ? { text: params.text } : {}),
            ...(params.schedule !== undefined ? { schedule: params.schedule } : {}),
            ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
            ...(params.archived !== undefined ? { archived: params.archived } : {}),
            ...(params.unfurlLinks !== undefined ? { unfurlLinks: params.unfurlLinks } : {}),
            ...(params.session !== undefined ? { session: params.session } : {}),
            ...(params.unattendedGrants !== undefined ? { unattendedGrants: params.unattendedGrants } : {}),
          });
          if (!r.ok) return refused(callId, "cron", r);
          return recordText(callId, { tool: "cron", id }, `Updated cron ${fmtCronLine(r.cron)}`);
        }
        case "delete": {
          const r = await tc.cronDelete(id);
          if (!r.ok) return refused(callId, "cron", r);
          return recordText(callId, { tool: "cron", id, deleted: true }, `Deleted cron ${id}.`);
        }
        case "disable": {
          const r = await tc.cronSetEnabled(id, false);
          if (!r.ok) return refused(callId, "cron", r);
          return recordText(callId, { tool: "cron", id, enabled: false }, `Paused cron ${id}.`);
        }
        case "run": {
          const r = await tc.cronRun(id);
          if (!r.ok) return refused(callId, "cron", r);
          return recordText(
            callId,
            { tool: "cron", id, ran: true },
            `Fired cron ${id} — the run is starting now and delivers on its own when it finishes.`,
          );
        }
        case "note": {
          if (typeof params.note !== "string" || !params.note.trim()) {
            return fail("note required", "cron note requires `note` (the short message the next fire reads).");
          }
          const r = await tc.cronNote(id, params.note);
          if (!r.ok) return refused(callId, "cron", r);
          return recordText(
            callId,
            { tool: "cron", id, noted: r.applied },
            r.applied
              ? `Noted — the next fire of ${id} will see it.`
              : `[not stored] a newer shift-change note for ${id} already exists — the next fire will see that one instead.`,
          );
        }
      }
    },
  });

  const webhook = defineTool({
    name: "webhook",
    label: "webhook",
    description:
      "Register and manage inbound webhooks — run a turn whenever an external system (GitHub, Stripe, " +
      "Slack, CI, a vendor — anything that can POST) calls a URL. Confirm with the user before creating one.\n" +
      "action=create takes `action` (what to do on each event; the event payload is appended " +
      "automatically), `verification` (how the request is authenticated), optional `filters` (skip the turn " +
      'unless the event matches — cheap pre-gating, e.g. [{path:"action",in:["opened"]}]), and optional ' +
      `\`destinationKey\` (a key from the "Where scheduled tasks post" menu). verification.scheme is one of ${WEBHOOK_SCHEMES.join(" | ")}: ` +
      `for ${SENDER_WEBHOOK_SCHEMES.join("/")} the USER gives you the signing secret from the ` +
      "sender's settings page; for hmac-sha256 generate a strong random secret yourself. A signing secret is always required.\n" +
      "create returns the inbound `url` and `secret` ONCE. You CANNOT open the sender's settings page, so " +
      "relay BOTH to the user verbatim — the `url` is already the full public inbound URL (hand it over as-is) " +
      "and the `secret` — so they can point GitHub/Stripe/etc. at it. Until they do, it never fires.\n" +
      "action=list pages through your webhooks (secrets elided, task text flattened and capped at 2000 chars, " +
      "25 per page — a footer line names the offset for the next page when there's more); action=update replaces one's task in place " +
      "(same URL and secret, used from the next event; live owner turns only); action=disable pauses one by id.",
    parameters: Type.Object({
      action: Type.Union(
        [Type.Literal("create"), Type.Literal("list"), Type.Literal("update"), Type.Literal("disable")],
        {
          description:
            "create an inbound webhook, list yours, update one's task in place by id (URL and secret unchanged), or disable one by id.",
        },
      ),
      id: optionalString("update and disable: the webhook id."),
      task: optionalString("create and update: what to do on each event (the payload is appended automatically)."),
      verification: Type.Optional(
        Type.Object(
          {
            scheme: Type.Union(
              WEBHOOK_SCHEMES.map((scheme) => Type.Literal(scheme)),
              { description: "how the inbound request is authenticated." },
            ),
            secret: Type.String({
              description: `the signing secret (from the sender for ${SENDER_WEBHOOK_SCHEMES.join("/")}; self-generated for hmac-sha256).`,
            }),
          },
          { description: "create only: the inbound authentication scheme + secret." },
        ),
      ),
      filters: Type.Optional(
        Type.Array(
          Type.Object({
            path: Type.String({ description: 'dotted path into the event payload, e.g. "action".' }),
            in: Type.Array(Type.String(), {
              description: "values that pass; the turn is skipped unless the path's value is one of these.",
            }),
          }),
          { description: "create only: skip the turn unless the event matches (cheap pre-gating)." },
        ),
      ),
      destinationKey: optionalString('create only: a key from the "Where scheduled tasks post" menu.'),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: "list only: page size (default 25, max 100)." })),
      offset: Type.Optional(
        Type.Integer({
          minimum: 0,
          description: "list only: start the page here — pass the offset the previous page's footer names to continue.",
        }),
      ),
    }),
    async execute(callId, params) {
      const tc = ref.current;
      if (!tc) return text("[error] no active tool context");
      await recordCall(callId, { tool: "webhook", action: params.action, ...(params.id ? { id: params.id } : {}) });
      switch (params.action) {
        case "create": {
          if (!params.verification || typeof params.task !== "string") {
            return recordFail(
              callId,
              { tool: "webhook", error: "verification and task required" },
              "[error] webhook create requires `task` (what to do per event) and `verification` ({scheme, secret?}).",
            );
          }
          const r = await tc.webhookCreate({
            action: params.task,
            verification: params.verification,
            ...(params.filters?.length ? { filters: params.filters } : {}),
            ...(params.destinationKey !== undefined ? { destinationKey: params.destinationKey } : {}),
          });
          if (!r.ok) return refused(callId, "webhook", r);

          const secretLine = `\nSecret (shown once — store it): ${r.secret}`;
          return recordText(
            callId,
            { tool: "webhook", id: r.webhook.id, url: r.url, secretShown: !!r.secret },
            `Registered webhook ${r.webhook.id}.\nInbound URL (give to the sender verbatim): ${r.url}${secretLine}\nIt won't fire until the sender is pointed at this URL.`,
          );
        }
        case "list": {
          const r = await tc.webhookList();
          if (isUnavailable(r)) return unavailable(callId, "webhook");
          if (!r.length) return recordText(callId, { tool: "webhook", count: 0 }, "(no webhooks registered here)");
          const { page, offset, note } = pageOf([...r].sort(listOrder), params);
          const lines = page.map(
            (w) =>
              `- ${w.id} (${w.verification.scheme}${w.enabled ? "" : ", paused"}): ${previewText(w.action, WEBHOOK_ACTION_PREVIEW_CHARS)}`,
          );
          return recordText(
            callId,
            { tool: "webhook", count: r.length, shown: page.length, ...(offset > 0 ? { offset } : {}) },
            [...lines, ...(note ? [`(${note})`] : [])].join("\n"),
          );
        }
        case "disable": {
          const id = typeof params.id === "string" && params.id ? params.id : null;
          if (!id)
            return recordFail(
              callId,
              { tool: "webhook", error: "id required" },
              "[error] webhook disable requires `id`.",
            );
          const r = await tc.webhookDisable(id);
          if (!r.ok) return refused(callId, "webhook", r);
          return recordText(callId, { tool: "webhook", id, enabled: false }, `Disabled webhook ${id}.`);
        }
        case "update": {
          const id = typeof params.id === "string" && params.id ? params.id : null;
          const task = typeof params.task === "string" ? params.task : "";
          if (!id)
            return recordFail(
              callId,
              { tool: "webhook", error: "id required" },
              "[error] webhook update requires `id` and the new `task`.",
            );
          const r = await tc.webhookUpdate(id, task);
          if (!r.ok) return refused(callId, "webhook", r);
          return recordText(
            callId,
            { tool: "webhook", id, updated: true },
            `Updated webhook ${id}. The next delivery uses the new task; URL and secret are unchanged.`,
          );
        }
      }
    },
  });
  return { cron, webhook };
}
