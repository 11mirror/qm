import { test } from "node:test";
import assert from "node:assert/strict";
import { countTokens } from "../../../src/util/tokens.ts";
import { renderComputerBlock } from "../../../src/core/environment-facts.ts";
import { renderGatewayContext } from "../../../src/core/gateway-context.ts";
import { sharedFilesSystemSection } from "../../../src/core/attachments.ts";
import {
  deliveryMenu,
  renderConversationRoster,
  renderReachRoster,
  renderStandingObligations,
} from "../../../src/core/orchestrator/prompt-blocks.ts";
import type { Cron, Webhook, Monitor, GrantedHandle, CandidateDestination } from "../../../src/types.ts";
import type { DirectoryMember, DirectoryChannel } from "../../../src/directory/directory-store.ts";

function checkOrder<T>(items: T[], render: (items: T[]) => string | null): void {
  const before = structuredClone(items);
  const expected = render(items);
  assert.equal(render(items.toReversed()), expected);
  assert.equal(render([...items.slice(3), ...items.slice(0, 3)]), expected);
  assert.deepEqual(items, before);
}

const BUDGET = 400;

test("prompt inventories keep identical bytes across permutations, including budgeted subsets", () => {
  const ids = Array.from({ length: 105 }, (_, i) => `id-${String(i).padStart(3, "0")}`);
  checkOrder<DirectoryMember>(
    ids.map((id) => ({ principalId: id, displayName: "Same name", type: "internal" })),
    (items) => renderConversationRoster(items, BUDGET),
  );
  checkOrder<DirectoryChannel>(
    ids.map((id) => ({ channelId: id, name: id })),
    (items) => renderReachRoster(items, "Alex", BUDGET),
  );
  checkOrder<CandidateDestination>(
    ids.map((id) => ({ key: id, label: id, type: "slack", target: id })),
    (items) => deliveryMenu(items, ids[5]),
  );
  checkOrder<GrantedHandle>(
    ids.map((id) => ({
      handlePath: `shared/${id}`,
      ownerScopeId: "personal:U1",
      fileId: id,
      permission: "read",
    })),
    (items) => sharedFilesSystemSection(items, BUDGET),
  );
  const base = ids.map((id) => ({
    id,
    ownerScopeId: "personal:U1" as const,
    owner: "U1",
    createdBy: "U1",
    createdAt: 1,
    enabled: true,
  }));
  checkOrder<Cron>(
    base.map((b) => ({ ...b, schedule: { everyMs: 60_000 }, action: b.id })),
    (items) => renderStandingObligations(items, [], [], BUDGET),
  );
  checkOrder<Webhook>(
    base.map((b) => ({ ...b, action: b.id, verification: { scheme: "github" } })),
    (items) => renderStandingObligations([], items, [], BUDGET),
  );
  checkOrder<Monitor>(
    base.map((b) => ({ ...b, processId: b.id, command: b.id, threadRef: "t", cursor: 0, expiresAt: 100 })),
    (items) => renderStandingObligations([], [], items, BUDGET),
  );
  assert.match(deliveryMenu([{ key: "x", label: "X", type: "slack", target: "x" }], "x"), /X \(default/);
});

test("environment and location facts are independent of discovery order", () => {
  checkOrder(["python", "node", "ruby", "bash"], (items) =>
    renderComputerBlock(
      { os: "Linux", runtimes: items, tools: items, notInstalled: items },
      { hasGlobal: false, teamCount: 0 },
    ),
  );
  checkOrder(
    [
      ["thread", "t"],
      ["channel", "c"],
      ["team", "t"],
    ],
    (items) => renderGatewayContext("slack", { details: Object.fromEntries(items) }),
  );
});

const cronsOf = (count: number) =>
  Array.from(
    { length: count },
    (_, i) =>
      ({
        id: `c${String(i).padStart(3, "0")}`,
        title: `Job ${i}`,
        schedule: { everyMs: 60_000 },
        createdAt: 0,
      }) as unknown as Cron,
  );

test("scheduled work in the prompt fills its token budget, then points at the full inventories", () => {
  const block = renderStandingObligations(cronsOf(400), [], [], BUDGET);
  const listed = block.split("\n").filter((line) => line.startsWith("- "));
  assert.ok(listed.length > 10 && listed.length < 400, `budgeted prefix, got ${listed.length}`);
  assert.ok(listed.reduce((n, line) => n + countTokens(line), 0) <= BUDGET);
  assert.match(
    block,
    new RegExp(`…and ${400 - listed.length} more — list crons, webhooks or job watches to see them all\\.$`),
  );
  const all = renderStandingObligations(cronsOf(400), [], [], 1_000_000);
  assert.equal(all.split("\n").filter((line) => line.startsWith("- ")).length, 400);
  assert.doesNotMatch(all, /…and \d+ more/);
});

test("webhook and job-watch obligations are named by their first line", () => {
  const webhook = {
    id: "w1",
    action: "Triage the issue\nThen label it",
    verification: { scheme: "github" },
  } as Webhook;
  const monitor = { id: "m1", processId: "p", command: "npm test", purpose: `${"a".repeat(300)}\nmore` } as Monitor;
  const block = renderStandingObligations([], [webhook], [monitor], 10_000);
  assert.match(block, /^- Webhook: Triage the issue$/m);
  assert.match(block, new RegExp(`^- Job watch: ${"a".repeat(300)}$`, "m"));
});

test("the roster keeps the speaker first and still shows a clipped entry when one line is over budget", () => {
  const members = Array.from({ length: 50 }, (_, i) => ({
    principalId: `U${String(i).padStart(4, "0")}`,
    displayName: `Person ${i}`,
    type: "internal" as const,
  }));
  const roster = renderConversationRoster(members, BUDGET, "U0042")!;
  const listed = roster.split("\n").filter((line) => line.startsWith("- "));
  assert.equal(listed[0], "- Person 42 (U0042)");
  assert.deepEqual(listed.slice(1, 3), ["- Person 0 (U0000)", "- Person 1 (U0001)"]);
  assert.equal(listed.filter((line) => line.includes("U0042")).length, 1);
  const giant = [{ principalId: "U1", displayName: "x".repeat(20_000), type: "internal" as const }, members[0]!];
  const clipped = renderConversationRoster(giant, 40, "U1")!;
  const shown = clipped.split("\n").filter((line) => line.startsWith("- "));
  assert.equal(shown.length, 1, "one clipped entry rather than none");
  assert.ok(shown[0]!.endsWith("…") && shown[0]!.length < 20_000 && countTokens(shown[0]!) <= 48);
  assert.match(clipped, /…and 1 more in this conversation\.$/);
});

test("conversation and reach rosters fill their token budget and count the rest", () => {
  const members = Array.from({ length: 800 }, (_, i) => ({
    principalId: `U${String(i).padStart(4, "0")}`,
    displayName: `Person ${i}`,
    type: "internal" as const,
  }));
  const roster = renderConversationRoster(members, BUDGET)!;
  const listed = roster.split("\n").filter((line) => line.startsWith("- "));
  assert.ok(listed.length > 10 && listed.length < 800, `budgeted prefix, got ${listed.length}`);
  assert.ok(listed.reduce((n, line) => n + countTokens(line), 0) <= BUDGET);
  assert.match(roster, new RegExp(`…and ${800 - listed.length} more in this conversation\\.$`));
  assert.equal(
    renderConversationRoster(members, 1_000_000)!
      .split("\n")
      .filter((l) => l.startsWith("- ")).length,
    800,
  );
  const channels = Array.from({ length: 300 }, (_, i) => ({
    channelId: `C${String(i).padStart(3, "0")}`,
    name: `room-${i}`,
  }));
  const reach = renderReachRoster(channels, "Alex", BUDGET)!;
  const shown = (reach.match(/#room-/g) ?? []).length;
  assert.ok(shown > 10 && shown < 300, `budgeted prefix, got ${shown}`);
  assert.match(reach, new RegExp(` …and ${300 - shown} more — name one to check`));
  assert.equal((renderReachRoster(channels, "Alex", 1_000_000)!.match(/#room-/g) ?? []).length, 300);
});
