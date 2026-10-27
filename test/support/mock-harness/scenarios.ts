import { EXECUTE_SCENARIOS } from "./execute.ts";
import { FAULT_SCENARIOS } from "./faults.ts";
import { REPLY_SCENARIOS } from "./replies.ts";
import { scenario, type MockScenario, type MockTurn } from "./shared.ts";
import { SLACK_SCENARIOS } from "./slack.ts";
import { WORKSPACE_SCENARIOS } from "./workspace.ts";

const READ_ONLY_BLOCKED_PREFIXES = [
  "!preamble",
  "!speakpost ",
  "!run ",
  "!execute ",
  "!scratch ",
  "!reach ",
  "!paused-approval ",
  "!collect-approval ",
  "!collect-exec ",
  "!screened-run ",
  "!double-exec ",
  "!read ",
  "!skill ",
  "!skill-run ",
  "!write ",
  "!attach ",
  "!writeattach ",
  "!attachsilent ",
  "!reachchan ",
  "!postthread ",
  "!broadcast ",
  "!post ",
  "!post2 ",
  "!post-lost-result ",
  "!post-then-boom ",
  "!postfiles ",
  "!react ",
  "!edit ",
  "!delete ",
  "!read_thread",
  "!whats_new",
  "!search ",
  "!read_members",
  "!read_file ",
  "!set_instructions ",
  "!get_instructions",
];

const readOnlyBlocked = scenario(
  "read-only-blocked",
  (t) => t.turn.readOnly && READ_ONLY_BLOCKED_PREFIXES.some((prefix) => t.command0.startsWith(prefix)),
  () => "[strict/read-only posture: that tool is unavailable]",
);

export const MOCK_SCENARIOS: readonly MockScenario[] = [
  readOnlyBlocked,
  ...FAULT_SCENARIOS,
  ...REPLY_SCENARIOS,
  ...EXECUTE_SCENARIOS,
  ...WORKSPACE_SCENARIOS,
  ...SLACK_SCENARIOS,
];

export function dispatchScenario(t: MockTurn) {
  const hit = MOCK_SCENARIOS.find((s) => s.matches(t));
  return hit ? hit.run(t) : `You said: ${t.modelPrompt}`;
}
