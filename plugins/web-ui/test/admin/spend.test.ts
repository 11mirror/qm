import assert from "node:assert/strict";
import test from "node:test";
import { background, person, DATA, EMPTY, render } from "../support/admin-spend.ts";
import { spendWindow } from "../../src/admin/spend.ts";

test("spend view: shows the saved report freshness", () => {
  const { f } = render({ ...DATA, asOf: Date.UTC(2026, 8, 25, 12) });
  assert.match(f.root.textContent!, /Totals as of.*Updated every minute/);
  f.window.close();
});

test("spend view: KPI stats, stacked chart and range tabs describe the whole org", () => {
  const { f, calls } = render(DATA);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.shell.stats)), [
    ["$16.00", "Total spend"],
    ["$16.00", "Live"],
    ["$0.00", "Background"],
    ["70.0%", "Cache hit rate"],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.shell.tabs.map((t: any) => [t.label, t.active]))), [
    ["7d", false],
    ["30d", true],
    ["90d", false],
    ["Custom", false],
  ]);
  assert.equal(f.root.querySelectorAll(".spend-column").length, 30, "zero-spend dates retain their space");
  assert.ok(f.root.textContent!.includes("$0.53"), "daily average includes zero-spend days");
  const bar = f.root.querySelectorAll<HTMLElement>(".spend-column")[29]!;
  bar.dispatchEvent(new f.window.Event("pointerenter"));
  assert.match(f.root.querySelector(".spend-chart-detail")!.textContent!, /Sep 24.*\$10.00 total.*Live \$10.00/);
  assert.equal(bar.querySelector<HTMLElement>(".spend-live")!.style.height, "100%");
  calls.shell.tabs[0].onClick();
  assert.deepEqual(calls.ranges, ["7d"]);
  f.window.close();
});

test("spend view: search narrows the per-person table without touching the org stats", () => {
  const { f, calls, peopleRows } = render(DATA);
  const before = calls.shell.stats;
  assert.deepEqual(peopleRows(), ["bob", "alice", "carol"]);
  calls.shell.search.onInput("ali");
  assert.deepEqual(peopleRows(), ["alice"]);
  assert.equal(calls.shell.stats, before, "the shellbar is not rebuilt and the totals stay org-wide");
  calls.shell.search.onInput("");
  assert.deepEqual(peopleRows(), ["bob", "alice", "carol"]);
  f.window.close();
});

test("spend view: a Total header click sorts ascending, a second click descending, with no refetch", () => {
  const { f, calls, peopleRows } = render(DATA);
  const totalHeader = () =>
    [...f.root.querySelectorAll(".tablewrap")[0]!.querySelectorAll("thead th button")].find((b) =>
      b.textContent!.includes("Total"),
    ) as HTMLElement;
  totalHeader().click();
  assert.deepEqual(peopleRows(), ["carol", "alice", "bob"]);
  totalHeader().click();
  assert.deepEqual(peopleRows(), ["bob", "alice", "carol"]);
  assert.equal(calls.api, 0, "sorting is client-side");
  f.window.close();
});

test("spend view: a row click opens the sorted row's principal, and Export CSV downloads", () => {
  const { f, calls } = render(DATA);
  const rows = f.root.querySelectorAll(".tablewrap")[0]!.querySelectorAll<HTMLTableRowElement>("tbody tr");
  rows[1]!.click();
  assert.deepEqual(calls.opened, ["alice"], "the click indexes the sorted rows on screen");
  calls.shell.actions[0].click();
  assert.equal(calls.downloads, 1);
  f.window.close();
});

test("spend view: shared-scope rows are labelled and never open a user page", () => {
  const { f } = render(DATA);
  const shared = f.root.querySelectorAll(".tablewrap")[1]!;
  assert.equal(shared.querySelector("tbody td")!.textContent!.trim(), "#general");
  assert.equal(shared.querySelectorAll("tr.openable").length, 0);
  f.window.close();
});

test("spend view: an empty window renders empty-state copy and n/a, not a confident 0.0%", () => {
  const { f, calls } = render(EMPTY);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.shell.stats[3])), ["n/a", "Cache hit rate"]);
  assert.equal(f.root.querySelectorAll(".tablewrap").length, 0);
  const text = f.root.textContent!;
  assert.ok(text.includes("No spend recorded in this window."), text);
  assert.ok(text.includes("No model calls recorded in this window."), text);
  f.window.close();
});

test("spend view: a null per-row cache ratio reads n/a", () => {
  const { f } = render({ ...DATA, people: [person("alice", 0, { cacheHitRatio: null })], scopes: [] });
  const cells = [...f.root.querySelectorAll(".tablewrap")[0]!.querySelectorAll("tbody td")].map((c) =>
    c.textContent!.trim(),
  );
  assert.equal(cells.at(-1), "n/a");
  f.window.close();
});

test("spend models: category breakdown, sorting, filtering and export", () => {
  const { f, calls } = render({
    ...DATA,
    models: [
      { ...person("", 10), model: "model-a", live: { costUsd: 3 }, background: background({ cron: 6, swarm: 1 }) },
      { ...person("", 6), model: null, live: { costUsd: 5 }, background: background({ webhook: 1 }) },
    ],
  });
  const names = () =>
    [...f.root.querySelectorAll(".spend-models tbody tr")].map((row) => row.querySelector("td")!.textContent!.trim());
  assert.deepEqual(names(), ["model-a", "Unknown model"]);
  const cells = [...f.root.querySelectorAll(".spend-models tbody tr:first-child td")].map((c) => c.textContent!.trim());
  assert.deepEqual(cells.slice(0, 4), ["model-a", "$10.00", "$3.00", "$7.00Crons $6.00 · Swarms $1.00"]);
  const backgroundHeader = [...f.root.querySelectorAll<HTMLElement>(".spend-models thead button")].find((b) =>
    b.textContent!.includes("Background"),
  )!;
  backgroundHeader.click();
  assert.deepEqual(names(), ["Unknown model", "model-a"]);
  calls.shell.search.onInput("model-a");
  assert.deepEqual(names(), ["model-a"]);
  calls.shell.search.onInput("unmatched");
  assert.match(f.root.querySelector(".spend-models")!.textContent!, /No models match/);
  [...f.root.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === "Export model CSV")!.click();
  assert.equal(calls.modelDownloads, 1);
  assert.equal(calls.downloads, 0);
  assert.deepEqual(calls.opened, []);
  f.window.close();
});

test("spend view: Custom turns the current window into two editable UTC days, applied on Apply as a sorted half-open window", () => {
  const preset = render(DATA, { window: { from: "2026-09-24", to: "2026-10-01", preset: "7d", bucket: "day" } });
  assert.equal(preset.f.root.querySelector(".spend-custom"), null);
  assert.deepEqual(JSON.parse(JSON.stringify(preset.calls.shell.tabs.map((t: any) => t.active))), [
    true,
    false,
    false,
    false,
  ]);
  preset.calls.shell.tabs.at(-1).onClick();
  assert.deepEqual(preset.calls.customs, [["2026-09-24", "2026-10-01"]]);
  preset.f.window.close();

  const { f, calls } = render(DATA, { window: { from: "2026-08-28", to: "2026-09-03", preset: null, bucket: "day" } });
  assert.deepEqual(JSON.parse(JSON.stringify(calls.shell.tabs.map((t: any) => [t.label, t.active]))), [
    ["7d", false],
    ["30d", false],
    ["90d", false],
    ["Custom", true],
  ]);
  const [first, last] = [...f.root.querySelectorAll<HTMLInputElement>(".spend-custom input")];
  assert.deepEqual([first!.value, last!.value], ["2026-08-28", "2026-09-02"]);
  const applyButton = f.root.querySelector<HTMLButtonElement>(".spend-custom button")!;
  last!.value = "2026-08-01";
  last!.dispatchEvent(new f.window.Event("change", { bubbles: true }));
  assert.deepEqual(calls.customs, [], "editing a day applies nothing until Apply");
  applyButton.click();
  assert.deepEqual(calls.customs, [["2026-08-01", "2026-08-29"]]);
  first!.value = "";
  applyButton.click();
  assert.equal(calls.customs.length, 1, "a cleared day applies nothing");
  calls.shell.tabs[0].onClick();
  assert.deepEqual(calls.ranges, ["7d"]);
  assert.equal(calls.api, 0);
  f.window.close();
});

test("spend view: crons show each cron's spend under its title, scope and schedule, filter, and open the cron's runs", () => {
  const opened: string[][] = [];
  const downloads: string[] = [];
  const cron = (cronId: string, costUsd: number, scopeId: string, scopeName: string, info: unknown) => ({
    ...person("", costUsd, { principalId: null, scopeId, kind: "person" }),
    cronId,
    scopeName,
    info,
  });
  const digest = {
    id: "abc123",
    title: "Morning digest",
    owner: "alice",
    ownerScopeId: "channel:C1",
    schedule: { cron: "0 9 * * 1-5" },
    enabled: true,
  };
  const { f, calls } = render(
    {
      ...DATA,
      crons: [
        cron("gone1234567890", 1, "personal:alice", "Alice", null),
        cron("abc123", 7, "channel:C1", "#general", digest),
      ],
    },
    {
      openCronRuns: (cronId: string, scope: string) => opened.push([cronId, scope]),
      downloadCsv: (breakdown?: string) => downloads.push(breakdown ?? "entity"),
    },
  );
  const rows = () => [...f.root.querySelectorAll<HTMLTableRowElement>(".spend-crons tbody tr")];
  const labels = () =>
    rows().map((row) => {
      const cell = row.querySelector("td")!;
      const where = cell.querySelector(".subline")!.textContent!;
      return [cell.textContent!.replace(where, "").trim(), where.trim()];
    });
  assert.deepEqual(labels(), [
    ["Morning digest", "#general · weekdays 9:00 AM"],
    ["Cron gone1234", "Alice · deleted"],
  ]);
  rows()[1]!.click();
  rows()[0]!.click();
  assert.deepEqual(opened, [
    ["gone1234567890", "personal:alice"],
    ["abc123", "channel:C1"],
  ]);
  [...f.root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Export cron CSV")!.click();
  assert.deepEqual(downloads, ["cron"]);
  for (const query of ["digest", "abc123", "general", "channel:C1"]) {
    calls.shell.search.onInput(query);
    assert.deepEqual(labels(), [["Morning digest", "#general · weekdays 9:00 AM"]], query);
  }
  f.window.close();
});

test("spend view: background by source names where background spend came from, largest first", () => {
  const { f } = render({
    ...DATA,
    org: { ...DATA.org, background: background({ cron: 6, webhook: 3, swarm: 1 }) },
  });
  const card = [...f.root.querySelectorAll(".tablewrap")].find((t) => t.textContent!.includes("Share of background"))!;
  const rows = [...card.querySelectorAll("tbody tr")].map((r) =>
    [...r.querySelectorAll("td")].slice(0, 3).map((c) => c.textContent!.trim()),
  );
  assert.deepEqual(rows, [
    ["Crons", "$6.00", "60.0%"],
    ["Webhooks", "$3.00", "30.0%"],
    ["Swarms", "$1.00", "10.0%"],
  ]);
  f.window.close();
});

const NOW = Date.parse("2026-09-30T15:00:00.000Z");

test("spend window: a valid custom window is used as-is, in daily buckets up to 62 days and weekly beyond", () => {
  assert.deepEqual(spendWindow({ range: "7d", from: "2026-09-01", to: "2026-10-01" }, NOW), {
    from: "2026-09-01",
    to: "2026-10-01",
    preset: null,
    bucket: "day",
  });
  assert.equal(spendWindow({ from: "2026-07-01", to: "2026-09-01" }, NOW).bucket, "day");
  assert.equal(spendWindow({ from: "2026-06-30", to: "2026-09-01" }, NOW).bucket, "week");
});

test("spend window: presets end tomorrow in UTC, and impossible, empty or reversed custom windows fall back to the preset", () => {
  assert.deepEqual(spendWindow({ range: "90d" }, NOW), {
    from: "2026-07-03",
    to: "2026-10-01",
    preset: "90d",
    bucket: "week",
  });
  assert.deepEqual(spendWindow({}, NOW), { from: "2026-09-01", to: "2026-10-01", preset: "30d", bucket: "day" });
  for (const [from, to] of [
    ["2026-09-01", "2026-09-01"],
    ["2026-10-01", "2026-09-01"],
    ["2026-02-30", "2026-03-02"],
    ["2026-9-1", "2026-10-01"],
    ["2026-09-01", null],
  ]) {
    assert.deepEqual(
      spendWindow({ range: "7d", from, to }, NOW),
      { from: "2026-09-24", to: "2026-10-01", preset: "7d", bucket: "day" },
      `${from} to ${to}`,
    );
  }
});

test("spend window: unknown or inherited preset names fall back to 30d, and a custom window ends by tomorrow and spans at most 366 days", () => {
  for (const range of ["constructor", "__proto__", "toString", "1d"]) {
    assert.deepEqual(
      spendWindow({ range }, NOW),
      { from: "2026-09-01", to: "2026-10-01", preset: "30d", bucket: "day" },
      range,
    );
  }
  assert.deepEqual(spendWindow({ from: "2026-09-15", to: "2027-01-01" }, NOW), {
    from: "2026-09-15",
    to: "2026-10-01",
    preset: null,
    bucket: "day",
  });
  assert.equal(
    spendWindow({ range: "7d", from: "2026-10-01", to: "2026-11-01" }, NOW).preset,
    "7d",
    "a window starting after today falls back to the preset",
  );
  assert.deepEqual(spendWindow({ from: "0002-10-15", to: "2026-10-01" }, NOW), {
    from: "2025-09-30",
    to: "2026-10-01",
    preset: null,
    bucket: "week",
  });
  assert.equal(spendWindow({ from: "2024-01-01", to: "2025-01-01" }, NOW).from, "2024-01-01", "a leap year fits");
});
