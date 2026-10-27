import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderComputerBlock,
  renderConnectedAppsBlock,
  environmentDelta,
  renderSandboxProfiles,
} from "../../src/core/environment-facts.ts";
import type { ConnectorStatusRecord } from "../../src/credentials/connector-status.ts";
import type { AgentComputerSpec } from "../../src/sandbox/sandbox.ts";
import { currentTimeBlock, renderStandingObligations } from "../../src/core/orchestrator/prompt-blocks.ts";
import { forModelContext } from "../../src/harness/context-compaction.ts";
import { reconstructMessagesFromHistory } from "../../src/harness/replay.ts";
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

function entry(seq: number, blocks: Record<string, string>, history: Item[]): Item {
  const snapshot = environmentDelta(blocks, history, "s");
  return storedItem(
    {
      kind: "UserMessage",
      text: "hello",
      body: { environment: snapshot.text, environmentSnapshot: snapshot.record },
    },
    { sessionId: "s", seq, createdAt: seq },
  );
}

test("snapshots survive serialized replay and emit only changed or removed inventories", () => {
  const original = { Credentials: "## Credentials\n- a\n- b", Sandboxes: "## Sandboxes\n- box" };
  const first = entry(1, original, []);
  const history: Item[] = JSON.parse(JSON.stringify([first]));
  assert.equal(environmentDelta(original, history, "s").text, "");
  const changed = { Credentials: "## Credentials\n- b\n- c" };
  const second = entry(2, changed, history);
  const text = String(second.body.environment);
  assert.match(text, /replace their earlier versions/);
  assert.match(text, /- c/);
  assert.doesNotMatch(text, /- a|- box/);
  assert.match(text, /No longer included: Sandboxes/);
  assert.equal(environmentDelta(changed, [...history, second], "s").text, "");
  const replay = reconstructMessagesFromHistory([...history, second]);
  assert.match(JSON.stringify(replay), /No longer included: Sandboxes/);
});

test("a compacted-away snapshot anchor resets the full baseline even when a later delta remains", () => {
  const blocks = { Credentials: "## Credentials\n- a", Skills: "## Skills\n- browse" };
  const first = entry(1, blocks, []);
  const second = entry(2, { ...blocks, Credentials: "## Credentials\n- b" }, [first]);
  const retained = forModelContext([second]);
  const reset = environmentDelta({ ...blocks, Credentials: "## Credentials\n- b" }, retained, "s");
  assert.match(reset.text, /## Skills/);
  assert.doesNotMatch(reset.text, /Environment changes/);
  assert.equal(reset.record.anchorSeq, undefined);
});

test("unrecorded attempts never advance the baseline; an emitted retry becomes the next baseline", () => {
  const blocks = { Skills: "## Skills\n- browse" };
  const first = entry(1, blocks, []);
  const changed = { Skills: "## Skills\n- search" };
  const attempt = environmentDelta(changed, [first], "s");
  assert.equal(environmentDelta(changed, [first], "s").text, attempt.text);
  const retry = entry(2, changed, [first]);
  assert.equal(environmentDelta(changed, [first, retry], "s").text, "");
  assert.match(environmentDelta({}, [first, retry], "s").text, /No longer included: Skills/);
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
  const text = renderStandingObligations(crons, [], []);
  assert.equal(text.split("\n").filter((line) => line.startsWith("- ")).length, 15);
  assert.match(text, /Task 14/);
  assert.match(text, /08:00 AM, only on Monday, Wednesday, and Friday/);
  assert.doesNotMatch(text, /cron-1|private instructions|private-owner|and .* more/);
  assert.match(
    renderStandingObligations(
      [{ ...crons[0]!, schedule: { cron: "0 8 * * FRI#L", timezone: "America/Los_Angeles" } }],
      [],
      [],
    ),
    /last Friday/,
  );
  const once = renderStandingObligations(
    [{ ...crons[0]!, schedule: { firstFireAt: Date.parse("2026-11-01T10:00:00Z") } }],
    [],
    [],
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

test("forked entries cannot mistake a resequenced row for the original snapshot anchor", () => {
  const blocks = { Skills: "## Skills\n- browse" };
  const original = entry(5, blocks, []);
  const delta = entry(8, blocks, [original]);
  const fork = [
    { ...original, sessionId: "fork", seq: 0 },
    { ...delta, sessionId: "fork", seq: 1 },
  ];
  assert.equal(environmentDelta(blocks, fork, "fork").text, blocks.Skills);
  assert.equal(environmentDelta(blocks, fork.slice(1), "fork").text, blocks.Skills);
  assert.doesNotMatch(JSON.stringify(delta.body), /## Skills.*## Skills/);
  assert.ok(!JSON.stringify(delta.body.environmentSnapshot).includes("browse"));
});
