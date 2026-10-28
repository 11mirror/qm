import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderComputerBlock,
  renderConnectedAppsBlock,
  membershipEvent,
  renderSandboxProfiles,
} from "../../src/core/environment-facts.ts";
import type { ConnectorStatusRecord } from "../../src/credentials/connector-status.ts";
import type { AgentComputerSpec } from "../../src/sandbox/sandbox.ts";
import { currentTimeBlock, renderStandingObligations } from "../../src/core/orchestrator/prompt-blocks.ts";
import type { Cron } from "../../src/types.ts";
import { storedItem, type Item } from "../../src/sessions/items.ts";

const FULL_SPEC: AgentComputerSpec = {
  os: "Debian 12 (bookworm), glibc",
  runtimes: ["Node 24", "Python 3 (venv on PATH)"],
  tools: ["git", "jq", "aws (CLI v2)"],
  notInstalled: ["gh", "gcloud"],
  cpus: 4,
  memoryMb: 8192,
  diskGb: 3,
  homeDir: "/root",
  workdir: "/root/workspace",
};

test("computer block: absent spec renders nothing (graceful for doubles)", () => {
  assert.equal(renderComputerBlock(undefined, { hasGlobal: false, teamCount: 0 }), "");
});

test("computer block: renders OS/size/runtimes/tools and the not-installed list", () => {
  const out = renderComputerBlock(FULL_SPEC, { hasGlobal: true, teamCount: 2 });
  assert.match(out, /## Sandbox environment profile/);
  assert.match(out, /Debian 12/);
  assert.match(out, /4 vCPU/);
  assert.match(out, /8 GB RAM/);
  assert.match(out, /3 GB disk/);
  assert.match(out, /Node 24/);
  assert.match(out, /Installed CLIs:.*aws/);
  assert.match(out, /NOT installed.*gh/);
  assert.match(out, /`\/root\/workspace` \(read-write\)/);
  assert.match(out, /\$HOME` \(`\/root`\) holds native logins/);
  assert.match(out, /`\.\/global` \(read-only\)/);
  assert.match(out, /team-\*.*2 mounted/);
});

test("computer block: omits global/team lines when not mounted (channel scope)", () => {
  const out = renderComputerBlock(FULL_SPEC, { hasGlobal: false, teamCount: 0 });
  assert.doesNotMatch(out, /global/);
  assert.doesNotMatch(out, /team-/);
});

test("computer block: partial spec omits the fields it lacks (no empty fragments)", () => {
  const out = renderComputerBlock({ os: "Debian 12", tools: ["git"] }, { hasGlobal: false, teamCount: 0 });
  assert.match(out, /## Sandbox environment profile/);
  assert.match(out, /Debian 12\./);
  assert.match(out, /Installed CLIs: git\./);
  assert.doesNotMatch(out, /vCPU/);
  assert.doesNotMatch(out, /Runtimes:/);
  assert.doesNotMatch(out, /NOT installed/);
});

test("connected-apps block: lists only admin-configured providers and the exact connection URL", () => {
  const url = "https://qm.example/keychain";
  const unavailable = renderConnectedAppsBlock(null, [], url);
  assert.match(unavailable, /No direct OAuth app connections are configured/);
  assert.match(unavailable, /does not describe app access through separately authorized credentials/);
  assert.match(unavailable, /Connection page: https:\/\/qm\.example\/keychain/);

  const none: ConnectorStatusRecord = { principalId: "U1", checkedAt: 1, providers: { google: { connected: false } } };
  const available = renderConnectedAppsBlock(none, ["google"], url);
  assert.match(available, /Available to connect: Google/);
  assert.match(available, /https:\/\/qm\.example\/keychain/);
  assert.doesNotMatch(available, /Slack|Notion/);

  const some: ConnectorStatusRecord = {
    principalId: "U1",
    checkedAt: 1,
    providers: { google: { connected: true }, slack: { connected: true }, notion: { connected: false } },
  };
  const out = renderConnectedAppsBlock(some, ["google"], url);
  assert.match(out, /## Connected apps/);
  assert.match(out, /Connected: Google/);
  assert.doesNotMatch(out, /Slack|Notion/);
});

test("connected-apps block: reconnect-needed apps are named separately", () => {
  const rec: ConnectorStatusRecord = {
    principalId: "U1",
    checkedAt: 1,
    providers: {
      google: { connected: true },
      github: {
        connected: true,
        expiresAt: 100,
        needsReconnect: true,
        refreshFailedAt: 200,
        refreshError: "revoked by provider",
      },
    },
  };
  const out = renderConnectedAppsBlock(rec, ["google", "github"]);
  assert.match(out, /Connected: Google/);
  assert.match(out, /Needs reconnect: GitHub \(refresh failed: revoked by provider\)/);
  assert.match(out, /Do not use these apps until the user reconnects them/);
});

test("connected-apps block is canonical across provider and status insertion order", () => {
  const providers = {
    slack: { connected: true },
    google: { connected: true },
    github: { connected: true, needsReconnect: true },
    dropbox: { connected: true, needsReconnect: true },
  };
  const record = { principalId: "U1", checkedAt: 1, providers };
  const available = ["slack", "google", "github", "dropbox", "linear", "notion"];
  const reversed = { ...record, providers: Object.fromEntries(Object.entries(providers).reverse()) };
  assert.equal(
    renderConnectedAppsBlock(record, available),
    renderConnectedAppsBlock(reversed, [...available].reverse()),
  );
  assert.deepEqual(Object.keys(providers), ["slack", "google", "github", "dropbox"]);
});

test("connected-apps block: names linked per-user MCP sign-ins by label", () => {
  const rec: ConnectorStatusRecord = {
    principalId: "U1",
    checkedAt: 1,
    providers: {
      google: { connected: true },
      orders: { connected: true, mcpLabel: "Orders" },
    },
  };
  const out = renderConnectedAppsBlock(rec, ["google"], "https://qm.example/keychain");
  assert.match(out, /Connected: Google, Orders\./);
  assert.doesNotMatch(out, /Available to connect: .*Orders/);

  const mcpOnly = renderConnectedAppsBlock(rec, [], "https://qm.example/keychain");
  assert.match(mcpOnly, /No direct OAuth app connections are configured/);
  assert.match(mcpOnly, /Connected: Orders\./);
  assert.doesNotMatch(mcpOnly, /Google/);
});

function rosterEntry(seq: number, roster: Array<{ principalId: string; displayName: string }>, history: Item[]): Item {
  const snapshot = membershipEvent(roster, history, "s");
  return storedItem(
    { kind: "UserMessage", text: "hello", body: { environment: snapshot.text, environmentSnapshot: snapshot.record } },
    { sessionId: "s", seq, createdAt: seq },
  );
}

test("membership emits only join/leave events, not the system inventory", () => {
  const alice = { principalId: "alice", displayName: "Alice" };
  const bob = { principalId: "bob", displayName: "Bob" };
  const first = rosterEntry(1, [alice], []);
  assert.equal(first.body.environment, "");
  const history = JSON.parse(JSON.stringify([first])) as Item[];
  assert.equal(membershipEvent([alice], history, "s").text, "");
  assert.equal(membershipEvent([bob], history, "s").text, "Joined: Bob (bob). Left: Alice.");
  assert.equal(membershipEvent(undefined, history, "s").record, undefined);
  const second = rosterEntry(2, [bob], history);
  assert.equal(membershipEvent([bob], [...history, second], "s").text, "");
  assert.equal(membershipEvent([bob], [{ ...first, sessionId: "fork" }], "fork").text, "");
});

test("local ISO clock follows daylight-saving transitions and non-hour offsets", () => {
  assert.match(
    currentTimeBlock("America/Los_Angeles", Date.parse("2026-03-08T09:59:59Z")),
    /2026-03-08T01:59:59-08:00/,
  );
  assert.match(
    currentTimeBlock("America/Los_Angeles", Date.parse("2026-03-08T10:00:00Z")),
    /2026-03-08T03:00:00-07:00/,
  );
  assert.match(currentTimeBlock("Asia/Kathmandu", 0), /1970-01-01T05:30:00\+05:30/);
});

test("standing work includes all titles and readable timings, not IDs, owners or task bodies", () => {
  const crons: Cron[] = Array.from({ length: 15 }, (_, i) => ({
    id: `cron-${i}`,
    ownerScopeId: "personal:U1",
    owner: "private-owner",
    createdBy: "U1",
    createdAt: 0,
    enabled: true,
    title: `Task ${i}`,
    action: "private instructions",
    schedule: { cron: "0 8 * * 1,3,5", timezone: "America/Los_Angeles" },
  }));
  const text = renderStandingObligations(crons, [], [], 10_000);
  assert.equal(text.split("\n").filter((line) => line.startsWith("- ")).length, 15);
  assert.match(text, /Task 14/);
  assert.match(text, /08:00 AM, only on Monday, Wednesday, and Friday/);
  assert.doesNotMatch(text, /cron-1|private instructions|private-owner|and .* more/);
  assert.match(
    renderStandingObligations(
      [{ ...crons[0]!, schedule: { cron: "0 8 * * FRI#L", timezone: "America/Los_Angeles" } }],
      [],
      [],
      10_000,
    ),
    /last Friday/,
  );
  const once = renderStandingObligations(
    [{ ...crons[0]!, schedule: { firstFireAt: Date.parse("2026-11-01T10:00:00Z") } }],
    [],
    [],
    10_000,
  );
  assert.match(once, /2026-11-01T02:00:00-08:00/);
});

test("live provider profiles represent configured and unknown capabilities without personal resources", () => {
  const inventory = renderSandboxProfiles(
    [
      { name: "modal", actions: ["create"], spec: { os: "Linux", tools: ["node"] } },
      { name: "sprites", actions: ["create"] },
    ],
    { hasGlobal: false, teamCount: 0 },
  );
  assert.match(inventory["Sandbox provider modal"]!, /node/);
  assert.match(inventory["Sandbox provider sprites"]!, /unknown/);
});
