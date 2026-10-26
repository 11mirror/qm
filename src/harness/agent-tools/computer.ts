import { Check } from "typebox/value";
import { isObj } from "../../util/objects.ts";
// The execute, sandbox and background tools: one command path for scoped, scratch, owner and reached computers.

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { redactSecrets } from "../../../plugins/chassis/src/redact-secrets.ts";
import { computerVerdict } from "../../sandbox/sandbox.ts";
import { MaskedExecutionError } from "../../security/secret-masking.ts";
import { CommandDenied, NeedsApproval } from "../../tools/primitives.ts";
import { errMessage } from "../../util/errors.ts";
import { type ToolKit } from "./kit.ts";
import {
  FILE_SEND_GUIDANCE,
  PRESSURE_WARN_FULL60,
  fmtStatus,
  optionalBoolean,
  optionalString,
  text,
} from "./shared.ts";

export function computerTools(kit: ToolKit) {
  const {
    ref,
    scratchExec,
    reachExec,
    execTimeoutSec,
    execCeilingSec,
    bgTtlSec,
    bgTtlMaxSec,
    bgTtlMin,
    bgTtlMaxMin,
    capabilityExpiry,
    log,
    recordCall,
    recordResult,
    recordText,
    recordFail,
  } = kit;
  const EXECUTE_TIMEOUT_GUIDANCE =
    "Commands may run under a POSIX sh such as dash, not bash: wrap bash-only syntax like ${var/a/b} or arrays in bash -c. " +
    `Each command has a wall-clock timeout (default ${execTimeoutSec}s, max ${execCeilingSec}s) — set \`timeout_seconds\` ` +
    "higher for builds/installs/tsc/test runs that legitimately take minutes, or lower for " +
    "commands you expect to be quick so a hang frees the machine fast. For work that " +
    `legitimately exceeds the ${execCeilingSec}s ceiling (long builds, installs, test suites, servers), use ` +
    "execute with background:true to run it detached, then use background to poll or watch the result across turns. " +
    "Always start servers with execute background:true, not shell ampersand: inherited output streams can keep execute waiting even after its shell exits. " +
    "If commands hang or fail with transport errors that nothing you ran explains, the computer itself may be " +
    "wedged — use sandbox action=status to inspect it out-of-band and action=restart to recover it. If a restart or two does not bring the shell back, stop restarting: create a fresh sandbox, set it as the default, and retry there, recovering work from git or Files.";

  const executeBaseParams = {
    command: Type.String({ description: "The shell command to run." }),
    background: optionalBoolean(
      "Run detached and return a process_id. Use background to poll, send input, stop, or watch the process. Only scoped execution supports background jobs.",
    ),
    sandbox_id: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Exact sandbox ID. Omit only when this scope has a stored default; otherwise select a target with sandbox list/create.",
      }),
    ),
    purpose: Type.String({
      description:
        "A human-readable intent label, at most 4 words (e.g. 'Check Python version'). " +
        "Describe the purpose, not the code. Required on every call; shown in tool activity and approval requests.",
    }),
    timeout_seconds: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          `Max wall-clock seconds before the command is killed (exit 124). Default ${execTimeoutSec}, max ${execCeilingSec}; background:true uses a job lifetime (default ${bgTtlSec}, max ${bgTtlMaxSec}). ` +
          "Raise this for builds/installs/tsc/test runs that legitimately take minutes; lower it " +
          "for commands you expect to be quick so a hang frees the machine fast.",
      }),
    ),

    credentials: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Exact authorized credential handles to materialize for this command only (for a background job, until it exits). Newly granted handles are accepted.",
      }),
    ),
  };

  const blockOnApproval = (
    callId: string,
    e: NeedsApproval,
    purpose?: string,
    tool = "execute",
    extra: Record<string, unknown> = {},
  ) => {
    ref.pendingApprovals?.push({
      command: e.command,
      reason: e.approvalReason,
      kind: e.kind,
      matched: e.matched,
      ...(purpose ? { purpose } : {}),
      ...(e.approvalKey ? { approvalKey: e.approvalKey } : {}),
      ...(e.grantModes ? { grantModes: e.grantModes } : {}),
    });
    ref.pausedOnApproval = true;
    return recordResult(
      callId,
      { tool, ...extra, blocked: "needs_approval", reason: e.approvalReason },
      { ...text(`[blocked: needs human approval] ${e.approvalReason}`), terminate: true },
      true,
    );
  };

  const runExecute = async (
    callId: string,
    params: {
      command: string;
      sandbox_id?: string | null;
      backend?: string;
      name?: string;
      to?: string;
      timeout_seconds?: number;
      purpose?: string;
      credentials?: string[];
    },
    route?: { scratch?: boolean; ownerAuth?: boolean; reachTarget?: string },
  ) => {
    const tc = ref.current;
    if (!tc) return text("[error] no active tool context");
    let scopeNote: { scope?: string } = {};
    if (route?.reachTarget !== undefined) {
      scopeNote = { scope: route.reachTarget };
    } else if (route !== undefined) {
      let scope = "scoped";
      if (route.ownerAuth) scope = "owner";
      else if (route.scratch) scope = "scratch";
      scopeNote = { scope };
    }
    await recordCall(callId, {
      tool: "execute",
      command: params.command,
      purpose: params.purpose,
      ...scopeNote,
      ...(params.sandbox_id !== undefined ? { sandbox_id: params.sandbox_id } : {}),
    });
    try {
      if (params.sandbox_id === null) throw new Error("a command requires a sandbox ID; null only clears the default");
      const execOpts = {
        ...(params.sandbox_id !== undefined ? { sandboxId: params.sandbox_id } : {}),
        ...(params.timeout_seconds !== undefined ? { timeoutSeconds: params.timeout_seconds } : {}),
        ...(route?.scratch ? { scratch: true } : {}),
        ...(route?.ownerAuth ? { ownerAuth: true } : {}),
        ...(route?.reachTarget !== undefined ? { reachTarget: route.reachTarget } : {}),
        ...(params.credentials?.length ? { credentials: params.credentials } : {}),
        ...(ref.abortSignal ? { signal: ref.abortSignal } : {}),
      };
      const r = await tc.execute(params.command, Object.keys(execOpts).length ? execOpts : undefined);
      const { stdout: _stdout, stderr: _stderr, ...execMeta } = r;
      const parts = [r.stdout, r.stderr ? `[stderr]\n${r.stderr}` : ""].filter(Boolean).join("\n");
      const reachedPrefix = r.reached ? `[ran on ${r.reached.label}'s computer]\n` : "";
      const localExec = !route?.scratch && !route?.ownerAuth && route?.reachTarget === undefined && !r.reached;
      const pressureNote =
        localExec && r.pressure && r.pressure.ioFull60 >= PRESSURE_WARN_FULL60
          ? `\n[pressure] this computer's disk is saturated (io ${r.pressure.ioFull60}%, load ${r.pressure.load1}) — sequence heavy work${scratchExec ? ', move self-contained runs to scope:"scratch"' : ""}, or check sandbox action=status`
          : "";
      return recordResult(
        callId,
        { tool: "execute", ...scopeNote, ...execMeta },
        {
          ...text(`${reachedPrefix}${parts}\n[exit ${r.code}${r.timedOut ? " timed-out" : ""}]${pressureNote}`),
          details: r,
        },
        r.timedOut,
        { screenAs: r.reached ? { provenance: "external", source: "reached room" } : undefined },
      );
    } catch (e) {
      if (e instanceof MaskedExecutionError) {
        return recordFail(callId, { tool: "execute", ...scopeNote }, e.message);
      }
      if (e instanceof NeedsApproval) return blockOnApproval(callId, e, params.purpose);
      if (e instanceof CommandDenied) {
        return recordFail(
          callId,
          { tool: "execute", denied: true, reason: e.message },
          `[denied by policy] ${e.message}`,
        );
      }
      await log("ToolResult", {
        tool: "execute",
        ...scopeNote,
        callId,
        isError: true,
        result: `Command execution failed: ${redactSecrets(errMessage(e))}`,
      });
      throw e;
    }
  };

  const invalidExecute = (callId: string, summary: Record<string, unknown>, message: string) =>
    recordFail(callId, summary, message);

  const scopedBullet =
    '- "scoped" (DEFAULT): this conversation\'s sandbox — its workspace files, turn-private inbox paths, shared-file handles, and $AGENT_API_* tokens; saved credentials require execute.credentials; working state is retained within provider recovery limits; publish durable code to git and artifacts to Files.\n';
  const scratchBullet = scratchExec
    ? '- "scratch": a blank computer for this turn, with the same OS/tooling, read-only org-global files and skills, this conversation\'s scoped $AGENT_API_* capabilities (including Files), and only credentials explicitly requested for this execute call. It does not restore the resident workspace or cached CLI logins. Its local files are discarded after the turn. Use it for self-contained commands and API work, including credential-using work; publish any needed outputs to Files and verify success before finishing. Use scope:"scoped" when you need existing workspace files, installed state, or local work that must continue later.\n'
    : "";
  const reachScopeDescription =
    (scratchExec ? '"scoped" (default) | "scratch" | ' : '"scoped" (default) | ') +
    '"owner" | ' +
    "a room like \"#project-alpha\" — a channel you and this person are both in; runs the command on THAT room's computer (read-only by etiquette: read, search, fetch — don't rearrange).";
  const reachDescription =
    "Run a shell command and return its stdout/stderr/exit code. Pick where it runs with `scope`:\n" +
    scopedBullet +
    scratchBullet +
    '- "owner": available to the live speaker in Open shared conversations and to owner-authorized shared automation; this invocation-only auth box has org-global files plus explicitly requested credentials, no room workspace or $AGENT_API_* tokens, and is destroyed after the turn. Use for commands that need the owner\'s login without putting it on the shared computer.\n' +
    "- a room like \"#project-alpha\": a channel you and this person are both in — runs the command on THAT room's computer. Other rooms are places you VISIT: read, search, fetch (ls/grep/cat); don't rearrange. That box has none of this conversation's logins or capability tokens. Say where anything you bring back came from.\n" +
    "If a file or piece of work isn't on this computer, don't declare it lost — check the rooms listed under 'Other computers you can reach'.\n" +
    FILE_SEND_GUIDANCE +
    EXECUTE_TIMEOUT_GUIDANCE;
  const scopeDescription =
    `Run a shell command and return its stdout/stderr/exit code. Pick a computer with \`scope\`:\n` +
    scopedBullet +
    '- "owner": available to the live speaker in Open shared conversations and to owner-authorized shared automation; this invocation-only auth box has org-global files plus explicitly requested credentials, no shared workspace or $AGENT_API_* tokens, and is destroyed after the turn. Use it for credential-using commands without putting personal logins on the shared computer.\n' +
    scratchBullet +
    FILE_SEND_GUIDANCE +
    EXECUTE_TIMEOUT_GUIDANCE;

  const runScopedExecute = async (
    callId: string,
    params: {
      command: string;
      timeout_seconds?: number;
      purpose?: string;
      scope?: string;
      credentials?: string[];
    },
  ) => {
    const scope = (params.scope ?? "scoped").trim();
    const keyword = scope.toLowerCase();
    if (keyword === "scoped") return runExecute(callId, params, { scratch: false });
    if (keyword === "scratch") {
      if (!scratchExec) {
        await recordCall(callId, { tool: "execute", command: params.command, purpose: params.purpose, scope });
        return invalidExecute(
          callId,
          { tool: "execute", invalid: "scratch_unavailable" },
          '[error] a scratch box isn\'t available here — use scope:"scoped" or name a room like "#project-alpha".',
        );
      }
      return runExecute(callId, params, { scratch: true });
    }
    if (keyword === "owner") return runExecute(callId, params, { ownerAuth: true });
    return runExecute(callId, params, { reachTarget: scope });
  };

  const runCommand = (
    callId: string,
    params: Parameters<typeof runScopedExecute>[1] & { background?: boolean; sandbox_id?: string },
  ) => (params.background ? runBackgroundExecute(callId, params) : runScopedExecute(callId, params));

  const execute = defineTool({
    name: "execute",
    label: "execute",
    description: reachExec ? reachDescription : scopeDescription,
    parameters: Type.Object({
      ...executeBaseParams,
      scope: reachExec
        ? Type.Optional(Type.String({ description: reachScopeDescription }))
        : Type.Optional(
            Type.Union(
              [Type.Literal("scoped"), ...(scratchExec ? [Type.Literal("scratch")] : []), Type.Literal("owner")],
              {
                description:
                  'Which computer runs this command: "scoped" (default — this conversation\'s sandbox: its working files and explicitly requested credentials; recovery depends on the provider) or "scratch" (blank filesystem for this turn, scoped API capabilities and explicitly requested credentials; no resident workspace or cached logins).',
              },
            ),
          ),
    }),
    execute: (callId, params) => runCommand(callId, params as Parameters<typeof runCommand>[1]),
  });

  const sandboxActions = Object.keys(SANDBOX_TOOL_ARGS.sandbox!);
  const sandboxManagement = defineTool({
    name: "sandbox",
    label: "sandbox",
    description:
      "Manage sandbox resources. list returns providers, supported actions, inventory, and this scope's optional default. If work needs a computer and this scope has no default, do not report blocked: list providers, create a sandbox, set_default to it, and retry. Only report blocked if creation fails. create provisions a blank sandbox without changing the default or copying files. set_default changes routing only; pass sandbox_id:null to clear it. status reports health and recovery expiry without provisioning. restart recovers working state where supported and stops running processes. retire deletes the named sandbox after its default and jobs are cleared. Durable outputs belong in Files or git. Select an exact sandbox_id for status/restart or omit it to use the stored default.",
    parameters: Type.Object({
      action: Type.String({ enum: sandboxActions }),
      sandbox_id: Type.Optional(
        Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
          description: "Exact sandbox ID; null is allowed only for set_default.",
        }),
      ),
      backend: optionalString("create only: provider from list."),
      name: optionalString("create only: human-readable name."),
      purpose: Type.String({ description: "Human-readable purpose, at most 4 words (e.g. 'Check sandbox health')." }),
    }),
    async execute(callId, params) {
      const tc = ref.current;
      if (!tc) return text("[error] no active tool context");
      await recordCall(callId, {
        tool: "sandbox",
        action: params.action,
        purpose: params.purpose,
        ...(params.sandbox_id !== undefined ? { sandbox_id: params.sandbox_id } : {}),
        ...(params.backend ? { backend: params.backend } : {}),
        ...(params.name ? { name: params.name } : {}),
      });
      try {
        if (["list", "create", "set_default", "retire"].includes(params.action)) {
          if (!tc.sandboxResources) throw new Error("sandbox inventory unavailable");
          const result = await tc.sandboxResources(
            (params.action === "set_default" ? "default" : params.action) as "list" | "create" | "default" | "retire",
            {
              backend: params.backend,
              name: params.name,
              sandboxId: params.sandbox_id,
            },
          );
          return recordText(callId, { tool: "sandbox", action: params.action }, JSON.stringify(result));
        }
        const sandboxId = params.sandbox_id ?? undefined;
        if (params.action === "restart") {
          await tc.restartComputer(sandboxId);
          return recordText(
            callId,
            { tool: "sandbox", action: "restart", restarted: true },
            "Computer restarting. Give it a moment to boot before running the next command.",
          );
        }
        const s = await tc.computerStatus(sandboxId);
        const verdict = computerVerdict(s);
        const machineLine = s.listed && s.listed !== s.machine ? `${s.machine} (listed: ${s.listed})` : s.machine;
        const pressureLine = s.pressure ? `; io pressure: ${s.pressure.ioFull60}% (load ${s.pressure.load1})` : "";
        const resourcesLine = s.resources
          ? `; cpu ${s.resources.cpuUsedPct}%, memory ${s.resources.memUsedMb}/${s.resources.memTotalMb} MiB, disk ${s.resources.diskUsedGb}/${s.resources.diskTotalGb} GiB`
          : "";
        let shellLine = s.guestResponsive ? "answering" : `NOT answering${s.probeError ? ` (${s.probeError})` : ""}`;
        if (s.lifecycleState === "paused") shellLine = "paused (not probed)";
        const recoveryLines: string[] = [];
        if (s.lifecycleState) recoveryLines.push(`lifecycle: ${s.lifecycleState}`);
        if (s.expiresAtMs !== undefined)
          recoveryLines.push(`machine expires: ${new Date(s.expiresAtMs).toISOString()}`);
        if (s.recovery) {
          recoveryLines.push(`recovery strategy: ${s.recovery.strategy}`);
          if (s.recovery.state) recoveryLines.push(`recovery state: ${s.recovery.state}`);
          if (s.recovery.checkpointId) recoveryLines.push(`checkpoint: ${s.recovery.checkpointId}`);
          if (s.recovery.checkpointAtMs !== undefined)
            recoveryLines.push(`checkpoint captured: ${new Date(s.recovery.checkpointAtMs).toISOString()}`);
          if (s.recovery.checkpointExpiresAtMs === null)
            recoveryLines.push("checkpoint expires: no provider expiry reported");
          else if (s.recovery.checkpointExpiresAtMs !== undefined)
            recoveryLines.push(`checkpoint expires: ${new Date(s.recovery.checkpointExpiresAtMs).toISOString()}`);
          if (s.recovery.error) recoveryLines.push(`recovery error: ${s.recovery.error}`);
        }
        const verdictLine =
          verdict === "wedged"
            ? " — WEDGED: a machine exists but its shell is not answering; the platform's health reporting goes stale in exactly this state, so trust the shell probe over any healthy/running claim and restart the computer; if it is still wedged after a restart or two, create a fresh sandbox, set it as the default, and retry there"
            : "";
        return recordText(
          callId,
          { tool: "sandbox", action: "status", verdict, ...s },
          [
            `machine: ${machineLine}; shell: ${shellLine}${pressureLine}${resourcesLine}${verdictLine}`,
            ...recoveryLines,
          ].join("\n"),
        );
      } catch (e) {
        if (e instanceof NeedsApproval) return blockOnApproval(callId, e, params.purpose, "sandbox");
        return recordFail(callId, { tool: "sandbox", action: params.action, failed: true }, `[error] ${errMessage(e)}`);
      }
    },
  });
  const runBackgroundExecute = async (callId: string, params: Parameters<typeof runCommand>[1]) => {
    const tc = ref.current;
    if (!tc) return text("[error] no active tool context");
    await recordCall(callId, { ...params, tool: "execute", background: true });
    if ((params.scope ?? "scoped").trim().toLowerCase() !== "scoped" || params.sandbox_id === null)
      return invalidExecute(
        callId,
        { tool: "execute", background: true },
        '[error] background jobs require scope:"scoped" with durable storage; use sandbox_id to select their computer.',
      );
    try {
      if (!params.command)
        return recordFail(
          callId,
          { tool: "execute", background: true, error: "start requires command" },
          "[error] execute background:true requires `command`.",
        );
      if (!params.purpose?.trim())
        return recordFail(
          callId,
          { tool: "execute", background: true, error: "start requires purpose" },
          "[error] execute background:true requires `purpose`: a short description of the job, about 5 words.",
        );
      const r = await tc.backgroundStart(params.command, {
        purpose: params.purpose,
        ...(params.timeout_seconds ? { ttlSeconds: params.timeout_seconds } : {}),
        ...(params.sandbox_id ? { sandboxId: params.sandbox_id } : {}),
        ...(params.credentials?.length ? { credentials: params.credentials } : {}),
      });
      const { output: _output, ...startMeta } = r;
      return recordResult(
        callId,
        { tool: "execute", background: true, ...startMeta },
        {
          ...text(
            `started ${r.processId}${r.reattached ? " (reattached)" : ""}\n${r.output}\n[cursor ${r.cursor} | ${fmtStatus(r.status)}]`,
          ),
          details: r,
        },
        false,
        { screenAs: { provenance: "external" } },
      );
    } catch (e) {
      if (e instanceof NeedsApproval) return blockOnApproval(callId, e, params.purpose);
      if (e instanceof CommandDenied)
        return recordFail(
          callId,
          { tool: "execute", background: true, denied: true, reason: e.message },
          `[denied by policy] ${e.message}`,
        );
      throw e;
    }
  };

  const background = defineTool({
    name: "background",
    label: "background",
    description:
      "Manage a command launched with execute background:true, which returns a process_id immediately. The " +
      "command keeps running across turns, even after you reply. action=poll reads new output and " +
      "tells you whether it's still running or has exited (with its exit code); pass the cursor " +
      "from your last poll as since_cursor to get only what's new, and call again to drain more " +
      "(output is paginated, ~64KB per read). action=stop terminates it (and its child processes). " +
      "action=list shows your background jobs (id, status, start time, command). " +
      "action=watch turns a running job into a push notifier for THIS conversation: instead of you " +
      "polling, new output (optionally only lines matching `pattern`) wakes you here as a new turn, " +
      "and you're woken once more when the job exits — use it to keep the user posted on long work " +
      "(builds, deploys, data jobs) without anyone asking. Pass the cursor from execute/poll as " +
      "since_cursor so the first wake carries only output you haven't seen, and `instructions` to " +
      "remind your future self what to do with each wake. action=unwatch (with monitor_id from " +
      `watch) disarms it. Each job has a hard time-to-live (default ${bgTtlMin} minutes, max ${bgTtlMaxMin}) after which ` +
      "it's stopped automatically (a watch survives just long enough to tell you) — for anything " +
      `that finishes within ${execCeilingSec}s, just use \`execute\`. Start jobs with execute background:true on the default sandbox or an authorized explicit sandbox_id; ` +
      "elsewhere, use `execute`. A background job carries the same environment a foreground `execute` " +
      `does — $AGENT_API_URL, $AGENT_API_TOKEN and $AGENT_CREDENTIAL_TOKEN all work, so self-API calls and shared-credential broker calls run fine from background work. ${capabilityExpiry}, and a background job cannot deliver a file itself, so write results to ordinary workspace paths and attach them from a live turn after polling.\n` +
      "INTERACTIVE LOGINS: device-flow logins (`gh auth login`, " +
      "`glab auth login`, `gcloud auth login`, and anything that prints a verification URL/code then " +
      "blocks waiting on a human) need execute background:true. Read the " +
      "URL/code from the returned output and relay it to the user, then `watch` (or `poll`) until the " +
      "command exits — that's when the login is done. If a prompt needs an answer typed in, use " +
      "action=send_input. Never run a login with foreground execute (it blocks the whole turn) and never `stop`/kill a " +
      "login mid-flight — that throws away the pending approval and wedges it. Read the `interactive-login` skill " +
      "before starting one and run it as the skill says: under a temporary home, never this computer's $HOME, then " +
      "saved to the keychain.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("poll"),
          Type.Literal("send_input"),
          Type.Literal("stop"),
          Type.Literal("list"),
          Type.Literal("watch"),
          Type.Literal("unwatch"),
        ],
        {
          description:
            "poll output by id, send_input to its stdin, stop it, list your background jobs, watch a job so its output/exit wakes you in this conversation, or unwatch.",
        },
      ),
      purpose: optionalString(
        "Short job description, about 5 words (e.g. 'App preview server'). Optional context for approval requests.",
      ),
      process_id: optionalString("poll/send_input/stop/watch only: the process_id execute returned."),
      data: optionalString(
        "send_input only: text sent to the job's stdin (a trailing newline is NOT added — include \\n to submit a line).",
      ),
      since_cursor: Type.Optional(
        Type.Integer({
          minimum: 0,
          description:
            "poll/watch only: the cursor from your last poll (watch: only output past it wakes you); omit to read from the start.",
        }),
      ),
      pattern: optionalString(
        'watch only: literal alternatives separated by |, with optional ^/$ anchors; only matching output lines wake you (e.g. "error|FAILED|passed"). Omit to be woken on any new output.',
      ),
      instructions: optionalString(
        "watch only: a note replayed to you with each wake, e.g. 'summarize test failures only'.",
      ),
      monitor_id: optionalString("unwatch only: the monitor id watch returned."),
      wait_seconds: Type.Optional(
        Type.Integer({
          minimum: 0,
          maximum: 60,
          description: "poll only: block up to this long for new output or exit, then answer (default 0).",
        }),
      ),
      max_bytes: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "poll only: cap bytes this read (default 65536); re-poll with the returned cursor for more.",
        }),
      ),
      signal: Type.Optional(
        Type.Union(
          [Type.Literal("TERM"), Type.Literal("KILL"), Type.Literal("INT"), Type.Literal("HUP"), Type.Literal("QUIT")],
          { description: "stop only: default TERM; use KILL to force." },
        ),
      ),
    }),
    async execute(callId, params) {
      const tc = ref.current;
      if (!tc) return text("[error] no active tool context");
      await recordCall(callId, {
        tool: "background",
        action: params.action,
        purpose: params.purpose,
        process_id: params.process_id,
        ...(params.monitor_id ? { monitor_id: params.monitor_id } : {}),
      });
      const pid = params.process_id ?? "";
      try {
        switch (params.action) {
          case "poll": {
            const r = await tc.backgroundPoll(pid, {
              ...(params.since_cursor !== undefined ? { sinceCursor: params.since_cursor } : {}),
              ...(params.max_bytes !== undefined ? { maxBytes: params.max_bytes } : {}),
              ...(params.wait_seconds !== undefined ? { waitSeconds: params.wait_seconds } : {}),
            });
            const { chunks: _chunks, ...pollMeta } = r;
            return recordResult(
              callId,
              { tool: "background", action: params.action, ...pollMeta },
              { ...text(`${r.chunks}\n[cursor ${r.cursor} | ${fmtStatus(r.status)}]`), details: r },
              false,
              { screenAs: { provenance: "external" } },
            );
          }
          case "stop": {
            const r = await tc.backgroundStop(pid, params.signal);
            return recordResult(
              callId,
              { tool: "background", action: params.action, ...r },
              { ...text(`signalled ${r.processId}; status now ${fmtStatus(r.status)}`), details: r },
            );
          }
          case "watch": {
            try {
              const r = await tc.backgroundWatch(pid, {
                ...(params.instructions !== undefined ? { instructions: params.instructions } : {}),
                ...(params.pattern !== undefined ? { pattern: params.pattern } : {}),
                ...(params.since_cursor !== undefined ? { sinceCursor: params.since_cursor } : {}),
              });
              if ("completed" in r) {
                const status = `${r.registryStatus}${r.exitCode !== undefined ? ` (code ${r.exitCode})` : ""}`;
                const result = r.outputTail
                  ? `job already ${status} — no watch armed; here is the tail of its output:\n${r.outputTail}`
                  : `job already ${status} — no watch armed; it produced no output.`;
                return recordResult(
                  callId,
                  { tool: "background", action: params.action, ...r },
                  { ...text(result), details: r },
                  false,
                  { screenAs: { provenance: "external", source: "finished job output" } },
                );
              }
              const trigger = params.pattern ? `new output matching /${params.pattern}/` : "new output";
              return recordResult(
                callId,
                { tool: "background", action: params.action, ...r },
                {
                  ...text(
                    `${r.reattached ? "already watching" : "watching"} ${r.processId} (monitor ${r.monitorId}) — ` +
                      `${trigger} and the job's exit will wake you in this conversation (watch expires ${new Date(r.expiresAt).toISOString()}).`,
                  ),
                  details: r,
                },
              );
            } catch (e) {
              if (e instanceof NeedsApproval || e instanceof CommandDenied) throw e;
              const msg = errMessage(e);
              return recordFail(
                callId,
                { tool: "background", action: params.action, error: msg },
                `[watch failed] ${msg}`,
              );
            }
          }
          case "unwatch": {
            try {
              const r = await tc.backgroundUnwatch(params.monitor_id!);
              return recordResult(
                callId,
                { tool: "background", action: params.action, ...r },
                text(r.removed ? `unwatched ${r.monitorId}` : `[no such watch: ${r.monitorId}]`),
                !r.removed,
              );
            } catch (e) {
              const msg = errMessage(e);
              return recordFail(
                callId,
                { tool: "background", action: params.action, error: msg },
                `[unwatch failed] ${msg}`,
              );
            }
          }
          case "send_input": {
            const r = await tc.backgroundWrite(pid, params.data!);
            return recordResult(
              callId,
              { tool: "background", action: params.action, ...r },
              { ...text(`wrote ${r.bytes}B to ${r.processId} stdin; ${fmtStatus(r.status)}`), details: r },
            );
          }
          case "list": {
            const jobs = await tc.backgroundList();
            return recordResult(
              callId,
              { tool: "background", action: params.action, jobs },
              {
                ...text(
                  jobs.length
                    ? jobs
                        .map(
                          (j) =>
                            `${j.processId}  ${j.registryStatus === "reaped" ? "stopped (ttl)" : fmtStatus(j.status)}  ${new Date(j.startedAt).toISOString()}  ${j.purpose ?? j.command}${j.purpose ? `\n  ${j.command}` : ""}`,
                        )
                        .join("\n")
                    : "(no background jobs)",
                ),
                details: { jobs },
              },
            );
          }
        }
      } catch (e) {
        if (e instanceof NeedsApproval)
          return blockOnApproval(callId, e, params.purpose, "background", { action: params.action });
        if (e instanceof CommandDenied) {
          return recordFail(
            callId,
            { tool: "background", action: params.action, denied: true, reason: e.message },
            `[denied by policy] ${e.message}`,
          );
        }
        throw e;
      }
    },
  });
  const validateSandboxTool = (tool: ToolDefinition): ToolDefinition => {
    const rules = SANDBOX_TOOL_ARGS[tool.name];
    if (!rules) return tool;
    const properties = (tool.parameters as { properties: Record<string, TSchema> }).properties;
    const schema = Type.Object(properties, { additionalProperties: false });
    return {
      ...tool,
      parameters: schema,
      async execute(callId, params, signal, onUpdate, ctx) {
        const action = isObj(params) ? String(params.action) : "";
        const key = "" in rules ? "" : action;
        const rule = Object.hasOwn(rules, key) ? rules[key] : undefined;
        const missing = rule?.required.find(
          (key) =>
            !isObj(params) ||
            params[key] === undefined ||
            (typeof params[key] === "string" && key !== "data" && !params[key].trim()),
        );
        const allowed = rule?.fields && ["action", "purpose", ...rule.fields, ...rule.required];
        if (
          !rule ||
          !Check(schema, params) ||
          missing ||
          (allowed && Object.keys(params).some((key) => !allowed.includes(key))) ||
          Object.entries(params).some(([key, value]) => value === null && !rule.nullable?.includes(key))
        ) {
          await recordCall(callId, {
            tool: tool.name,
            ...(isObj(params) ? { purpose: params.purpose, action: params.action } : {}),
          });
          return recordFail(
            callId,
            { tool: tool.name, invalid: true },
            `[error] invalid ${tool.name} arguments: ${missing ? `requires \`${missing}\`` : "use only the advertised fields and types for this operation"}.`,
          );
        }
        return tool.execute(callId, params, signal, onUpdate, ctx);
      },
    };
  };
  return { execute, sandboxManagement, background, validateSandboxTool };
}

/**
 * Argument rules for execute, sandbox and background, keyed by tool then action ("" = the tool has no
 * action). `required` fields must be present and non-blank; `fields` (with `required`, `action` and
 * `purpose`) are the only ones an action accepts, and omitting it skips that check; `nullable` fields
 * may be null. A call breaking a rule is refused before the tool runs, so handlers can rely on them.
 */
const SANDBOX_TOOL_ARGS: Record<
  string,
  Record<string, { required: string[]; fields?: string[]; nullable?: string[] }>
> = {
  execute: { "": { required: ["command", "purpose"] } },
  sandbox: {
    status: { required: ["purpose"], fields: ["sandbox_id"] },
    restart: { required: ["purpose"], fields: ["sandbox_id"] },
    list: { required: ["purpose"], fields: [] },
    create: { required: ["purpose", "backend"], fields: ["name"] },
    set_default: { required: ["purpose", "sandbox_id"], fields: [], nullable: ["sandbox_id"] },
    retire: { required: ["purpose", "sandbox_id"], fields: [] },
  },
  background: {
    poll: { required: ["process_id"], fields: ["since_cursor", "wait_seconds", "max_bytes"] },
    send_input: { required: ["process_id", "data"], fields: [] },
    stop: { required: ["process_id"], fields: ["signal"] },
    list: { required: [], fields: [] },
    watch: { required: ["process_id"], fields: ["since_cursor", "pattern", "instructions"] },
    unwatch: { required: ["monitor_id"], fields: [] },
  },
};
