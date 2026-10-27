import assert from "node:assert/strict";
import { scopeId, type SessionType } from "../../src/types.ts";
import type { SessionStore, SpendRow } from "../../src/sessions/session-store.ts";

const DAY = 86_400_000;
const BASE = Date.UTC(2021, 0, 1);

type Recorder = (
  threadRef: string,
  type: SessionType,
  scope: string,
  costUsd: number | null,
  model?: string,
) => Promise<{ id: string }>;

interface ParityCtx {
  store: SessionStore;
  clock: { at: number };
  prefix: string;
  alice: ReturnType<typeof scopeId>;
  bob: ReturnType<typeof scopeId>;
  channel: ReturnType<typeof scopeId>;
  record: Recorder;
}

function spendRow(
  day: number,
  scope: string,
  model: string,
  origin: SpendRow["origin"],
  cronId: string | null,
  calls: number,
  costUsd: number,
): SpendRow {
  return {
    day,
    scopeId: scope,
    model,
    origin,
    cronId,
    calls,
    costUsd,
    input: 100 * calls,
    output: 20 * calls,
    cacheRead: 400 * calls,
    cacheWrite: 40 * calls,
  };
}

async function assertWindowedRollup({ store, clock, prefix, alice, bob, channel, record }: ParityCtx): Promise<void> {
  const mine = new Set<string>([alice, bob, channel]);
  await record(`${prefix}:alice-live-a`, "dm", alice, 1.5);
  await record(`${prefix}:alice-live-b`, "dm", alice, 0.25);
  await record(`${prefix}:alice-live-a`, "dm", alice, 0.75, "other-model");
  await record(`${prefix}:channel-live`, "channel", channel, 2);
  await record(`cron:${prefix}-nightly:fire:aaa`, "dm", alice, 0.5);
  clock.at += DAY;
  await record(`${prefix}:alice-live-c`, "dm", alice, 0.125);
  await record(`${prefix}:bob-live`, "dm", bob, 4);
  await record(`${prefix}:bob-unpriced`, "dm", bob, null);
  clock.at += DAY;
  await record(`${prefix}:alice-out-of-window`, "dm", alice, 8);

  await store.recordLlmRequest(`${prefix}-orphan-session`, {
    turnSeq: null,
    step: 0,
    model: "mock",
    scopeLabel: alice,
    usage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, totalTokens: 4, costUsd: 99 },
  });

  const day = Math.floor(BASE / DAY);
  const rollup = (await store.spendRollup({ from: BASE, to: BASE + 2 * DAY })).filter((r) => mine.has(r.scopeId));
  const key = (r: SpendRow) => JSON.stringify([r.day, r.scopeId, r.origin, r.cronId, r.model]);
  const byKey = (a: SpendRow, b: SpendRow) => {
    if (key(a) === key(b)) return 0;
    return key(a) < key(b) ? -1 : 1;
  };
  const sorted = [...rollup].sort(byKey);

  const expected = [
    spendRow(day, alice, "other-model", "conversation", null, 1, 0.75),
    spendRow(day, alice, "mock", "conversation", null, 2, 1.75),
    spendRow(day, alice, "mock", "cron", `${prefix}-nightly`, 1, 0.5),
    spendRow(day, channel, "mock", "conversation", null, 1, 2),
    spendRow(day + 1, alice, "mock", "conversation", null, 1, 0.125),
    spendRow(day + 1, bob, "mock", "conversation", null, 1, 4),
  ].sort(byKey);

  assert.deepEqual(sorted, expected);
}

async function assertInheritedOrigins({ store, clock, prefix, alice, bob, record }: ParityCtx): Promise<void> {
  clock.at = BASE;
  const child = async (name: string, parentId: string) => {
    const session = await record(`agent:main:subagent:${prefix}-${name}`, "dm", alice, 0.01, `${prefix}-${name}`);
    await store.setParentSession(session.id, parentId);
    return session;
  };
  const parents = {
    cron: `agent:main:cron:${prefix}-parent`,
    webhook: `agent:main:webhook:${prefix}-parent`,
    monitor: `agent:main:monitor:${prefix}-parent`,
    loop: `loop:${prefix}-parent:fire:aaa`,
    swarm: `swarm:${prefix}-parent:member`,
    conversation: `agent:main:conversation:${prefix}-parent`,
  };
  for (const [origin, threadRef] of Object.entries(parents)) {
    const parent = await store.getOrCreateByThread(threadRef, "dm", bob);
    const first = await child(`${origin}-child`, parent.id);
    await child(`${origin}-grandchild`, first.id);
  }
  await child("missing-parent", `${prefix}-missing`);
  const deleted = await store.getOrCreateByThread(`cron:${prefix}-deleted`, "dm", bob);
  await child("deleted-parent", deleted.id);
  await store.deleteSession(deleted.id);
  const cycleA = await child("cycle-a", `${prefix}-missing`);
  const cycleB = await child("cycle-b", cycleA.id);
  await store.setParentSession(cycleA.id, cycleB.id);
  const self = await child("self-cycle", `${prefix}-missing`);
  await store.setParentSession(self.id, self.id);

  const inherited = (await store.spendRollup({ from: BASE, to: BASE + DAY })).filter((r) =>
    r.model?.startsWith(`${prefix}-`),
  );
  const origins = new Map<string, string>([
    ...Object.keys(parents).flatMap((origin) =>
      ["child", "grandchild"].map((kind) => [`${prefix}-${origin}-${kind}`, origin] as const),
    ),
    ...["missing-parent", "deleted-parent", "cycle-a", "cycle-b", "self-cycle"].map(
      (name) => [`${prefix}-${name}`, "conversation"] as const,
    ),
  ]);
  assert.equal(inherited.length, origins.size);
  for (const row of inherited) {
    assert.equal(row.origin, origins.get(row.model!), row.model!);
    assert.equal(row.cronId, row.origin === "cron" ? `${prefix}-parent` : null, row.model!);
    assert.equal(row.scopeId, alice, "inherit origin, not the parent's scope");
    assert.equal(row.calls, 1);
    assert.equal(row.costUsd, 0.01);
  }
}

async function assertChangingParent({ store, clock, prefix, alice, bob, record }: ParityCtx): Promise<void> {
  clock.at = BASE + 123;
  const changing = await record(`${prefix}:changing`, "dm", alice, 0, `${prefix}-changing`);
  const range = { from: clock.at, to: clock.at + 1 };
  const readChanging = async () => (await store.spendRollup(range)).filter((r) => r.model === `${prefix}-changing`);
  assert.equal((await readChanging())[0]!.calls, 1);
  assert.equal((await readChanging())[0]!.costUsd, 0);
  assert.equal(
    (await store.spendRollup({ from: BASE, to: clock.at })).some((r) => r.model === `${prefix}-changing`),
    false,
  );
  await record(`${prefix}:changing`, "dm", alice, 2, `${prefix}-changing`);
  assert.equal((await readChanging())[0]!.calls, 2);
  assert.equal((await readChanging())[0]!.costUsd, 2);
  const cronParent = await store.getOrCreateByThread(`cron:${prefix}-changing:fire:aaa`, "dm", bob);
  await store.setParentSession(changing.id, cronParent.id);
  assert.equal((await readChanging())[0]!.origin, "cron");
  assert.equal((await readChanging())[0]!.cronId, `${prefix}-changing`);
  await store.deleteSession(cronParent.id);
  assert.equal((await readChanging())[0]!.origin, "conversation");
  assert.equal((await readChanging())[0]!.cronId, null);
  await store.deleteSession(changing.id);
  assert.deepEqual(await readChanging(), []);
}

export async function assertSpendRollupParity(
  makeStore: (now: () => number) => SessionStore,
  prefix: string,
): Promise<void> {
  const clock = { at: BASE + 6 * 3_600_000 };
  const store = makeStore(() => clock.at);
  const alice = scopeId("personal", `${prefix}-alice`);
  const bob = scopeId("personal", `${prefix}-bob`);
  const channel = scopeId("channel", `${prefix}-C1`);

  const record = async (
    threadRef: string,
    type: SessionType,
    scope: string,
    costUsd: number | null,
    model = "mock",
  ) => {
    const session = await store.getOrCreateByThread(threadRef, type, scope);
    await store.recordLlmRequest(session.id, {
      turnSeq: null,
      step: 0,
      model,
      scopeLabel: scope,
      usage:
        costUsd === null ? null : { input: 100, output: 20, cacheRead: 400, cacheWrite: 40, totalTokens: 560, costUsd },
    });
    return session;
  };

  const ctx = { store, clock, prefix, alice, bob, channel, record };
  await assertWindowedRollup(ctx);
  await assertInheritedOrigins(ctx);
  await assertChangingParent(ctx);
}
