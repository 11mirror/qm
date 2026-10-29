import { test } from "../support/tenant-test.ts";
import assert from "node:assert/strict";
import pg from "pg";
import { subscribePostgresChannel } from "../../src/persistence/postgres-listener.ts";
import { createPostgresNotifyBus } from "../../src/persistence/postgres-notify-bus.ts";
import { createPostgresRunSignalStore } from "../../src/runs/postgres-run-signal-store.ts";
import { settle } from "../support/settle.ts";

const url = process.env.DATABASE_URL!;
test("channels share a backend, recover after termination, and release it after unsubscribe", async () => {
  const observer = new pg.Client({ connectionString: url });
  await observer.connect();
  const seen: string[] = [];
  let resyncs = 0;
  const stops: (() => Promise<void>)[] = [];
  const pids = async () =>
    (
      await observer.query(
        "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'LISTEN consolidation_%' AND pid<>pg_backend_pid()",
      )
    ).rows.map((r) => r.pid);
  try {
    stops.push(
      subscribePostgresChannel(
        url,
        "consolidation_a",
        (v) => seen.push(`a:${v}`),
        () => resyncs++,
      ),
    );
    stops.push(
      subscribePostgresChannel(
        url,
        "consolidation_b",
        (v) => seen.push(`b:${v}`),
        () => resyncs++,
      ),
    );
    await settle(() => resyncs === 2);
    assert.equal((await pids()).length, 1);
    await observer.query("SELECT pg_notify('consolidation_a','one'),pg_notify('consolidation_b','two')");
    await settle(() => seen.length === 2);
    assert.deepEqual(seen.sort(), ["a:one", "b:two"]);
    await observer.query("SELECT pg_terminate_backend($1)", [(await pids())[0]]);
    await settle(() => resyncs === 4);
    assert.equal((await pids()).length, 1);
    await stops[0]!();
    await observer.query("SELECT pg_notify('consolidation_a','ignored'),pg_notify('consolidation_b','three')");
    await settle(() => seen.includes("b:three"));
    assert.equal(seen.length, 3);
    await stops[1]!();
    await settle(async () => (await pids()).length === 0);
  } finally {
    await Promise.all(stops.map((stop) => stop()));
    await observer.end();
  }
});

test("notification buses and run signals share a listener without closing their siblings", async () => {
  const a = createPostgresNotifyBus<string>(url, "consolidation_bus", "test");
  const b = createPostgresNotifyBus<string>(url, "consolidation_bus", "test");
  const signals = createPostgresRunSignalStore(url);
  const observer = new pg.Client({ connectionString: url });
  await observer.connect();
  let ready = 0;
  let messages = 0;
  let signalsSeen = 0;
  const offA = a.subscribe(() => messages++, { onResync: () => ready++ });
  const offB = b.subscribe(() => messages++, { onResync: () => ready++ });
  const offSignal = signals.onSignal("consolidation-run", () => signalsSeen++);
  try {
    await settle(() => ready === 2 && signalsSeen > 0);
    signalsSeen = 0;
    await observer.query("SELECT pg_notify('run_signals','consolidation-run')");
    await settle(() => signalsSeen > 0);
    a.emit("one");
    await settle(() => messages === 2);
    offA();
    await a.close!();
    b.emit("two");
    await settle(() => messages === 3);
    offSignal();
    await signals.close!();
    b.emit("three");
    await settle(() => messages === 4);
  } finally {
    offA();
    offB();
    offSignal();
    await Promise.all([a.close!(), b.close!(), signals.close!()]);
    await observer.end();
  }
});

test("immediate unsubscribe and replacement do not leak a pending connection", async () => {
  const first = subscribePostgresChannel(
    url,
    "consolidation_race",
    () => {},
    () => {},
  );
  const closing = first();
  let ready = false;
  const second = subscribePostgresChannel(
    url,
    "consolidation_race",
    () => {},
    () => {
      ready = true;
    },
  );
  try {
    await closing;
    await settle(() => ready);
  } finally {
    await second();
  }
});
