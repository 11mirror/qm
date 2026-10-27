import { toolCallApprovalKey } from "../../../src/core/approval-id.ts";
import { NeedsApproval } from "../../../src/tools/primitives.ts";
import {
  approvalFrom,
  argAfter,
  execOutput,
  is,
  type MockScenario,
  type MockTurn,
  silentFire,
  splitWord,
  startsWith,
  tool,
} from "./shared.ts";

const emitExecCall = (t: MockTurn, body: Record<string, unknown>) =>
  t.turn.emit({ kind: "ToolCall", tool: "execute", body });

export const EXECUTE_SCENARIOS: MockScenario[] = [
  tool("execute", startsWith("!execute "), async (t) => {
    const params = JSON.parse(argAfter(t, "!execute ")) as {
      command: string;
      credentials?: string[];
      scratch?: boolean;
      sandboxId?: string;
    };
    const result = await t.turn.tools.execute(params.command, {
      credentials: params.credentials,
      scratch: params.scratch,
      sandboxId: params.sandboxId,
    });
    await t.turn.emit({ kind: "ToolResult", body: { ...result } });
    return execOutput(result);
  }),
  tool(
    "run/scratch",
    (t) => t.command0.startsWith("!run ") || t.command0.startsWith("!scratch "),
    async (t) => {
      const tag = t.command0.startsWith("!scratch ") ? "!scratch " : "!run ";
      const inboxDir = /available in \.\/(\S+?)\/:/.exec(t.turn.environment ?? "")?.[1] ?? "inbox";
      const command = argAfter(t, tag).replaceAll("{INBOX}", inboxDir);
      await emitExecCall(t, { command });
      const result = await t.turn.tools.execute(command, tag === "!scratch " ? { scratch: true } : undefined);
      await t.turn.emit({ kind: "ToolResult", body: { ...result } });
      return execOutput(result);
    },
  ),
  tool("screened-run", startsWith("!screened-run "), async (t) => {
    const command = argAfter(t, "!screened-run ");
    await emitExecCall(t, { command });
    const result = await t.turn.tools.execute(command);
    const output = execOutput(result);
    t.turn.observeToolResult?.({ tool: "execute", result: output, unscreenable: false, provenance: "external" });
    await t.turn.emit({ kind: "ToolResult", body: { ...result } });
    return output;
  }),
  tool("reach", startsWith("!reach "), async (t) => {
    const [room, command] = splitWord(t.command0.slice("!reach ".length));
    await emitExecCall(t, { command, scope: room });
    try {
      const result = await t.turn.tools.execute(command, { reachTarget: room });
      await t.turn.emit({ kind: "ToolResult", body: { ...result } });
      return execOutput(result);
    } catch (e) {
      return `[reach error] ${e instanceof Error ? e.message : String(e)}`;
    }
  }),
  tool("paused-approval", startsWith("!paused-approval "), async (t) => {
    const command = t.command0.slice("!paused-approval ".length);
    await emitExecCall(t, { command, blocked: "needs_approval" });
    t.collected.push({ command, reason: "requires approval" });
    t.pausedOnApproval = true;
    return "about to run it";
  }),
  tool("finish-silent-paused", is("!finish-silent-paused"), (t) => {
    t.silent = silentFire(t);
    t.pausedOnApproval = true;
    t.collected.push({ command: "gated-check", reason: "requires approval" });
    return "";
  }),
  tool("collect-approval", startsWith("!collect-approval "), async (t) => {
    const command = t.command0.slice("!collect-approval ".length);
    await emitExecCall(t, { command, blocked: "needs_approval" });
    t.collected.push({ command, reason: "requires approval" });
    return "worked around it; done";
  }),
  tool("collect-exec", startsWith("!collect-exec "), async (t) => {
    const command = t.command0.slice("!collect-exec ".length);
    await emitExecCall(t, { command });
    try {
      const result = await t.turn.tools.execute(command);
      return execOutput(result);
    } catch (e) {
      if (!(e instanceof NeedsApproval)) throw e;
      t.collected.push(approvalFrom(e));
      return `[blocked] ${e.approvalReason}`;
    }
  }),
  tool("double-exec", startsWith("!double-exec "), async (t) => {
    const command = t.command0.slice("!double-exec ".length);
    let ran = 0;
    for (let i = 0; i < 2; i++) {
      await emitExecCall(t, { command });
      try {
        const result = await t.turn.tools.execute(command);
        await t.turn.emit({ kind: "ToolResult", body: { ...result } });
        ran++;
      } catch (e) {
        if (!(e instanceof NeedsApproval)) throw e;
        t.collected.push(approvalFrom(e));
      }
    }
    return `ran ${ran}`;
  }),
  tool("declared", startsWith("!declared "), (t) => {
    const args = JSON.parse(t.command0.slice("!declared ".length)) as Record<string, unknown>;
    const callKey = toolCallApprovalKey("example_send", args);
    if (t.turn.toolApprovalGate?.(callKey)) return `sent ${JSON.stringify(args)}`;
    t.collected.push({
      command: `example_send ${JSON.stringify(args)}`,
      reason: "this tool asks for approval before each call",
      kind: "approval",
      approvalKey: callKey,
      summary: "example_send",
      grantModes: { session: false, always: false },
    });
    t.pausedOnApproval = true;
    return "";
  }),
];
