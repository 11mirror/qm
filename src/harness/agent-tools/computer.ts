import { Check } from "typebox/value";
import { isObj } from "../../util/objects.ts";

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { redactSecrets } from "../../../plugins/chassis/src/redact-secrets.ts";
import { computerVerdict } from "../../sandbox/sandbox.ts";
import { MaskedExecutionError } from "../../security/secret-masking.ts";
import { CommandDenied, NeedsApproval } from "../../tools/primitives.ts";
import { errMessage } from "../../util/errors.ts";
import { SANDBOX_CAPABILITY_TTL_MS } from "../../auth/capability-token.ts";
import { BACKGROUND_JOB_TTL_MAX_MS, BACKGROUND_JOB_TTL_MS } from "../../connectors/background-exec-broker.ts";
import { type ToolKit } from "./kit.ts";
import type { TurnHalt } from "../turn-tool-state.ts";
import { optionalBoolean, optionalString, text } from "./shared.ts";

export const EXEC_TIMEOUT_DEFAULT_MS = 120_000;
export const EXEC_TIMEOUT_MAX_MS = 300_000;
const EXEC_TIMEOUT_SEC = EXEC_TIMEOUT_DEFAULT_MS / 1000;
const EXEC_CEILING_SEC = EXEC_TIMEOUT_MAX_MS / 1000;
const BG_TTL_SEC = Math.round(BACKGROUND_JOB_TTL_MS / 1000);
const BG_TTL_MAX_SEC = Math.round(BACKGROUND_JOB_TTL_MAX_MS / 1000);
const BG_TTL_MIN = Math.round(BG_TTL_SEC / 60);
const BG_TTL_MAX_MIN = Math.round(BG_TTL_MAX_SEC / 60);
const CAPABILITY_EXPIRY = `Those turn tokens expire ${SANDBOX_CAPABILITY_TTL_MS / 3_600_000} hours after the launching turn started (then they 401), so publish checkpoints to Files before that and keep the file ID.`;

export function computerTools(kit: ToolKit, halt: Pick<TurnHalt, "pauseForApproval">) {
  const core = executeCore(kit, halt);
  return {
    execute: executeTool(kit, core),
    sandboxManagement: sandboxTool(kit, core),
    background: backgroundTool(kit, core),
    validateSandboxTool: sandboxValidation(kit),
  };
}

const EXECUTE_TIMEOUT_GUIDANCE =
  "Commands may run under POSIX sh; wrap bash-only syntax in bash -c. " +
  `Timeout default ${EXEC_TIMEOUT_SEC}s, max ${EXEC_CEILING_SEC}s: raise \`timeout_seconds\` for builds/installs/tests, lower it for quick commands. ` +
  "For anything longer, and for servers, use background:true (never a shell ampersand) and the background tool. " +
  "On hangs or unexplained transport errors use sandbox status/restart; if that fails twice, create a fresh sandbox, set it default, and recover work from git or Files.";

const EXECUTE_BASE_PARAMS = {
  command: Type.String({ description: "The shell command to run." }),
  background: optionalBoolean("Run detached and return a process_id for the background tool. Scoped only."),
  sandbox_id: Type.Optional(
    Type.String({
      minLength: 1,
      description: "Exact sandbox ID; omit to use this scope's default.",
    }),
  ),
  purpose: Type.String({
    description:
      "Intent label, at most 4 words, describing the purpose not the code; shown in activity and approval requests.",
  }),
  timeout_seconds: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: `Seconds until kill (exit 124); default ${EXEC_TIMEOUT_SEC}, max ${EXEC_CEILING_SEC}. With background:true, the job lifetime (default ${BG_TTL_SEC}, max ${BG_TTL_MAX_SEC}).`,
    }),
  ),

  credentials: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Exact authorized credential handles to materialize for this command only (for a background job, until it exits). Newly granted handles are accepted. In a shared conversation, credentials other than brokered org services run on this turn's scratch computer instead, even with sandbox_id (no shared workspace files: fetch scripts from Files or git in the command); a background job naming them gets its own computer that nothing else can reach.",
    }),
  ),
};

function executeCore(kit: ToolKit, halt: Pick<TurnHalt, "pauseForApproval">) {
  const { ref, log, recordCall, recordResult, recordFail } = kit;
  const blockOnApproval = (
    callId: string,
    e: NeedsApproval,
    purpose?: string,
    tool = "execute",
    extra: Record<string, unknown> = {},
  ) => {
    halt.pauseForApproval({
      command: e.command,
      reason: e.approvalReason,
      kind: e.kind,
      matched: e.matched,
      ...(purpose ? { purpose } : {}),
      ...(e.approvalKey ? { approvalKey: e.approvalKey } : {}),
      ...(e.grantModes ? { grantModes: e.grantModes } : {}),
    });
    return recordResult(
      callId,
      { tool, ...extra, blocked: "needs_approval", reason: e.approvalReason },
      { ...text(`[blocked: needs human approval] ${e.approvalReason}`), terminate: true },
      true,
    );
  };

  const policyRefusal = (
    callId: string,
    e: unknown,
    purpose: string | undefined,
    tool: string,
    extra: Record<string, unknown> = {},
  ) => {
    if (e instanceof NeedsApproval) return blockOnApproval(callId, e, purpose, tool, extra);
    if (e instanceof CommandDenied)
      return recordFail(callId, { tool, ...extra, denied: true, reason: e.message }, `[denied by policy] ${e.message}`);
    return null;
  };

  const runExecute = async (
    callId: string,
    params: {
      command: string;
      sandbox_id?: string;
      timeout_seconds?: number;
      purpose?: string;
      credentials?: string[];
    },
    route?: { scratch?: boolean; reachTarget?: string },
  ) => {
    const tc = ref.current;
    if (!tc) return text("[error] no active tool context");
    let scopeNote: { scope?: string } = {};
    if (route?.reachTarget !== undefined) {
      scopeNote = { scope: route.reachTarget };
    } else if (route !== undefined) {
      scopeNote = { scope: route.scratch ? "scratch" : "scoped" };
    }
    await recordCall(callId, {
      tool: "execute",
      command: params.command,
      purpose: params.purpose,
      ...scopeNote,
      ...(params.sandbox_id !== undefined ? { sandbox_id: params.sandbox_id } : {}),
    });
    try {
      const execOpts = {
        ...(params.sandbox_id !== undefined ? { sandboxId: params.sandbox_id } : {}),
        ...(params.timeout_seconds !== undefined ? { timeoutSeconds: params.timeout_seconds } : {}),
        ...(route?.scratch ? { scratch: true } : {}),
        ...(route?.reachTarget !== undefined ? { reachTarget: route.reachTarget } : {}),
        ...(params.credentials?.length ? { credentials: params.credentials } : {}),
        ...(ref.abortSignal ? { signal: ref.abortSignal } : {}),
      };
      const r = await tc.execute(params.command, Object.keys(execOpts).length ? execOpts : undefined);
      const { stdout: _stdout, stderr: _stderr, scratchReroute, ...execMeta } = r;
      const resultScope = scratchReroute ? { scope: "scratch" } : scopeNote;
      const parts = [r.stdout, r.stderr ? `[stderr]\n${r.stderr}` : ""].filter(Boolean).join("\n");
      let placePrefix = "";
      if (r.reached) placePrefix = `[ran on ${r.reached.label}'s computer]\n`;
      else if (scratchReroute)
        placePrefix =
          "[ran on this turn's scratch computer, not the shared one, because it names a private credential; its files are discarded after the turn]\n";
      const localExec = !route?.scratch && !scratchReroute && route?.reachTarget === undefined && !r.reached;
      const pressureNote =
        localExec && r.pressure && r.pressure.ioFull60 >= PRESSURE_WARN_FULL60
          ? `\n[pressure] this computer's disk is saturated (io ${r.pressure.ioFull60}%, load ${r.pressure.load1}) — sequence heavy work, move self-contained runs to scope:"scratch", or check sandbox action=status`
          : "";
      return recordResult(
        callId,
        { tool: "execute", ...resultScope, ...execMeta },
        {
          ...text(`${placePrefix}${parts}\n[exit ${r.code}${r.timedOut ? " timed-out" : ""}]${pressureNote}`),
          details: r,
        },
        r.timedOut,
        { screenAs: r.reached ? { provenance: "external", source: "reached room" } : undefined },
      );
    } catch (e) {
      if (e instanceof MaskedExecutionError) {
        return recordFail(callId, { tool: "execute", ...scopeNote }, e.message);
      }
      const refused = policyRefusal(callId, e, params.purpose, "execute");
      if (refused) return refused;
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
  return { blockOnApproval, policyRefusal, runExecute };
}

type ExecuteCore = ReturnType<typeof executeCore>;

function sandboxTool(kit: ToolKit, { blockOnApproval }: ExecuteCore) {
  const { ref, recordCall, recordText, recordFail } = kit;
  const sandboxActions = Object.keys(SANDBOX_TOOL_ARGS.sandbox!);
  const sandboxManagement = defineTool({
    name: "sandbox",
    label: "sandbox",
    description:
      "Manage sandbox computers. list: providers, inventory, this scope's default. create: a blank sandbox (default unchanged). set_default: route commands there (null clears). status: health. restart: stop processes, recover state where supported. retire: delete (not while default or running jobs). If work needs a computer and there is no default, list, create, set_default and retry; report blocked only if creation fails. Durable outputs belong in git or Files.",
    parameters: Type.Object({
      action: Type.String({ enum: sandboxActions }),
      sandbox_id: Type.Optional(
        Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
          description: "Sandbox ID; status/restart use the default if omitted. null only for set_default.",
        }),
      ),
      backend: optionalString("create: provider from list."),
      name: optionalString("create: display name."),
      purpose: Type.String({ description: "As for execute." }),
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
            ? " — wedged: a machine exists but its shell did not answer the probe, so its machine state may be stale"
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
  return sandboxManagement;
}

function executeTool(kit: ToolKit, { runExecute, policyRefusal }: ExecuteCore) {
  const { ref, reachExec, recordCall, recordResult, recordFail } = kit;
  const scopedLine =
    '- "scoped" (default): this conversation\'s sandbox: its workspace files and $AGENT_API_* tokens; saved credentials only via `credentials`. Working state survives only within provider recovery limits: push code to git, save artifacts to Files.\n';
  const scratchLine =
    '- "scratch": blank per-turn computer with the same tooling, read-only org-global files and skills, this conversation\'s $AGENT_API_* capabilities and requested credentials; no workspace or cached logins; files discarded after the turn, so publish outputs to Files and verify it worked.\n';
  const reachScopeDescription =
    '"scoped" (default) | "scratch" | ' +
    'a room like "#project-alpha" (a shared channel): runs on that room\'s computer, read-only by etiquette.';
  const reachDescription =
    "Run a shell command and return stdout/stderr/exit code. `scope` picks the computer:\n" +
    scopedLine +
    scratchLine +
    "- a room like \"#project-alpha\" (a shared channel): runs on that room's computer. Visit only — read, search, fetch; don't rearrange. It has none of this conversation's logins or tokens; say where anything you bring back came from. Before calling work lost, check the rooms under 'Other computers you can reach'.\n" +
    FILE_SEND_GUIDANCE +
    EXECUTE_TIMEOUT_GUIDANCE;
  const scopeDescription =
    "Run a shell command and return stdout/stderr/exit code. `scope` picks the computer:\n" +
    scopedLine +
    scratchLine +
    FILE_SEND_GUIDANCE +
    EXECUTE_TIMEOUT_GUIDANCE;

  const runScopedExecute = async (
    callId: string,
    params: {
      command: string;
      timeout_seconds?: number;
      purpose: string;
      scope?: string;
      credentials?: string[];
    },
  ) => {
    const scope = (params.scope ?? "scoped").trim();
    const keyword = scope.toLowerCase();
    if (keyword === "scoped") return runExecute(callId, params, { scratch: false });
    if (keyword === "scratch") {
      return runExecute(callId, params, { scratch: true });
    }
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
      ...EXECUTE_BASE_PARAMS,
      scope: reachExec
        ? Type.Optional(Type.String({ description: reachScopeDescription }))
        : Type.Optional(
            Type.Union([Type.Literal("scoped"), Type.Literal("scratch")], {
              description: "Which computer runs this; see the tool description.",
            }),
          ),
    }),
    execute: (callId, params) => runCommand(callId, params as Parameters<typeof runCommand>[1]),
  });

  const runBackgroundExecute = async (callId: string, params: Parameters<typeof runCommand>[1]) => {
    const tc = ref.current;
    if (!tc) return text("[error] no active tool context");
    await recordCall(callId, { ...params, tool: "execute", background: true });
    if ((params.scope ?? "scoped").trim().toLowerCase() !== "scoped")
      return recordFail(
        callId,
        { tool: "execute", background: true },
        '[error] background jobs require scope:"scoped" with durable storage; use sandbox_id to select their computer.',
      );
    try {
      const r = await tc.backgroundStart(params.command, {
        purpose: params.purpose,
        ...(params.timeout_seconds ? { ttlSeconds: params.timeout_seconds } : {}),
        ...(params.sandbox_id ? { sandboxId: params.sandbox_id } : {}),
        ...(params.credentials?.length ? { credentials: params.credentials } : {}),
      });
      const { output: _output, jobComputer, ...startMeta } = r;
      const placePrefix = jobComputer
        ? "[running on a computer reserved for this job because it names a private credential; nobody can run commands on it, and it is destroyed after the job ends]\n"
        : "";
      return recordResult(
        callId,
        { tool: "execute", background: true, ...startMeta },
        {
          ...text(
            `${placePrefix}started ${r.processId}${r.reattached ? " (reattached)" : ""}\n${r.output}\n[cursor ${r.cursor} | ${fmtStatus(r.status)}]`,
          ),
          details: r,
        },
        false,
        { screenAs: { provenance: "external" } },
      );
    } catch (e) {
      const refused = policyRefusal(callId, e, params.purpose, "execute", { background: true });
      if (refused) return refused;
      throw e;
    }
  };
  return execute;
}

function backgroundTool(kit: ToolKit, { policyRefusal }: ExecuteCore) {
  const background = defineTool({
    name: "background",
    label: "background",
    description:
      "Manage a job started with execute background:true; it keeps running across turns. " +
      "poll: new output and running/exited state (pass the last cursor as since_cursor; ~64KB per read). send_input: write to stdin. stop: terminate it. list: your jobs. " +
      "watch: wake this conversation as a new turn on new output (optionally only lines matching `pattern`) and once on exit, to keep the user posted on long work; pass since_cursor and `instructions` for your future self. unwatch: disarm by monitor_id. " +
      `Jobs stop after a hard TTL (default ${BG_TTL_MIN} min, max ${BG_TTL_MAX_MIN}); anything that finishes within ${EXEC_CEILING_SEC}s should just use execute. ` +
      `The job has the same environment as foreground execute ($AGENT_API_URL, $AGENT_API_TOKEN, $AGENT_CREDENTIAL_TOKEN). ${CAPABILITY_EXPIRY} It cannot deliver files; attach them from a live turn.\n` +
      "INTERACTIVE LOGINS (`gh auth login` etc., anything printing a URL/code then waiting) must run with background:true: relay the URL/code to the user, then watch or poll until exit; answer prompts with send_input; never run one in the foreground or stop it mid-flight. Read and follow the `interactive-login` skill first.",
    parameters: backgroundParams(),
    execute: (callId, params) => runBackgroundAction(kit, policyRefusal, callId, params),
  });
  return background;
}

function backgroundParams() {
  return Type.Object({
    action: Type.Union([
      Type.Literal("poll"),
      Type.Literal("send_input"),
      Type.Literal("stop"),
      Type.Literal("list"),
      Type.Literal("watch"),
      Type.Literal("unwatch"),
    ]),
    purpose: optionalString("Short job description, about 5 words."),
    process_id: optionalString("The process_id execute returned."),
    data: optionalString("send_input: stdin text; include \\n to submit a line."),
    since_cursor: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "poll/watch: cursor from the last poll; omit for the start.",
      }),
    ),
    pattern: optionalString(
      "watch: literal alternatives separated by |, optional ^/$ anchors; omit to wake on any output.",
    ),
    instructions: optionalString("watch: note replayed to you on each wake."),
    monitor_id: optionalString("unwatch: the monitor id watch returned."),
    wait_seconds: Type.Optional(
      Type.Integer({ minimum: 0, description: "poll: block up to this long for output or exit (default 0)." }),
    ),
    max_bytes: Type.Optional(Type.Integer({ minimum: 1, description: "poll: cap bytes this read (default 65536)." })),
    signal: Type.Optional(
      Type.Union(
        [Type.Literal("TERM"), Type.Literal("KILL"), Type.Literal("INT"), Type.Literal("HUP"), Type.Literal("QUIT")],
        { description: "stop: default TERM." },
      ),
    ),
  });
}

async function runBackgroundAction(
  kit: ToolKit,
  policyRefusal: ExecuteCore["policyRefusal"],
  callId: string,
  params: Static<ReturnType<typeof backgroundParams>>,
) {
  const { ref, recordCall, recordResult, recordFail } = kit;
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
      }
      case "unwatch": {
        const r = await tc.backgroundUnwatch(params.monitor_id!);
        return recordResult(
          callId,
          { tool: "background", action: params.action, ...r },
          text(r.removed ? `unwatched ${r.monitorId}` : `[no such watch: ${r.monitorId}]`),
          !r.removed,
        );
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
    const refused = policyRefusal(callId, e, params.purpose, "background", { action: params.action });
    if (refused) return refused;
    if (params.action !== "watch" && params.action !== "unwatch") throw e;
    const msg = errMessage(e);
    return recordFail(
      callId,
      { tool: "background", action: params.action, error: msg },
      `[${params.action} failed] ${msg}`,
    );
  }
}

function sandboxValidation(kit: ToolKit) {
  const { recordCall, recordFail } = kit;
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
  return validateSandboxTool;
}

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

const PRESSURE_WARN_FULL60 = 50;

function fmtStatus(s: { state: "running" } | { state: "exited"; code: number }): string {
  return s.state === "exited" ? `exited ${s.code}` : "running";
}

const FILE_SEND_GUIDANCE =
  "execute, files, skills and apps use the default sandbox when sandbox_id is omitted. Send files with the surface `post` action's `files` if present, else `attach` (workspace paths or {file_id}); background jobs cannot deliver files. ";
