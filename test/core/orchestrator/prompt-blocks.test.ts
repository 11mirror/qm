import { test } from "node:test";
import assert from "node:assert/strict";
import { renderComputerBlock } from "../../../src/core/environment-facts.ts";
import { renderGatewayContext } from "../../../src/core/gateway-context.ts";
import { sharedManifest } from "../../../src/core/attachments.ts";
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

test("prompt inventories keep identical bytes across permutations", () => {
  const ids = Array.from({ length: 105 }, (_, i) => `id-${String(i).padStart(3, "0")}`);
  checkOrder<DirectoryMember>(
    ids.map((id) => ({ principalId: id, displayName: "Same name", type: "internal" })),
    renderConversationRoster,
  );
  checkOrder<DirectoryChannel>(
    ids.map((id) => ({ channelId: id, name: id })),
    (items) => renderReachRoster(items, "Alex"),
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
    sharedManifest,
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
    (items) => renderStandingObligations(items, [], []),
  );
  checkOrder<Webhook>(
    base.map((b) => ({ ...b, action: b.id, verification: { scheme: "github" } })),
    (items) => renderStandingObligations([], items, []),
  );
  checkOrder<Monitor>(
    base.map((b) => ({ ...b, processId: b.id, command: b.id, threadRef: "t", cursor: 0, expiresAt: 100 })),
    (items) => renderStandingObligations([], [], items),
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

test("scheduled work in the prompt lists every obligation, naming webhooks and watches by their first line", () => {
  const crons = Array.from(
    { length: 32 },
    (_, i) =>
      ({
        id: `c${String(i).padStart(2, "0")}`,
        title: `Job ${i}`,
        schedule: { everyMs: 60_000 },
        createdAt: 0,
      }) as unknown as Cron,
  );
  const webhook = {
    id: "w1",
    action: "Triage the issue\nThen label it",
    verification: { scheme: "github" },
  } as Webhook;
  const monitor = { id: "m1", processId: "p", command: "npm test", purpose: `${"a".repeat(300)}\nmore` } as Monitor;
  const block = renderStandingObligations(crons, [webhook], [monitor]);
  assert.equal(block.split("\n").filter((line) => line.startsWith("- ")).length, 34);
  assert.doesNotMatch(block, /…and \d+ more/);
  assert.match(block, /^- Webhook: Triage the issue$/m);
  assert.match(block, new RegExp(`^- Job watch: ${"a".repeat(300)}$`, "m"));
});

test("conversation and reach rosters name every member and room", () => {
  const members = Array.from({ length: 45 }, (_, i) => ({
    principalId: `U${i}`,
    displayName: `Person ${i}`,
    type: "internal" as const,
  }));
  const roster = renderConversationRoster(members)!;
  assert.equal(roster.split("\n").filter((line) => line.startsWith("- ")).length, 45);
  assert.doesNotMatch(roster, /more in this conversation/);
  const channels = Array.from({ length: 45 }, (_, i) => ({ channelId: `C${i}`, name: `room-${i}` }));
  const reach = renderReachRoster(channels, "Alex")!;
  assert.equal((reach.match(/#room-/g) ?? []).length, 45);
  assert.doesNotMatch(reach, /name one to check/);
});
