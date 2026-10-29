import assert from "node:assert/strict";
import test from "node:test";
import { background, person, DATA, render } from "../support/admin-spend.ts";

test("spend chart: category stacks and keyboard details use exact amounts", () => {
  const { f } = render({
    ...DATA,
    series: [{ day: "2026-09-24", live: { costUsd: 3 }, background: background({ cron: 3, swarm: 0.5 }) }],
  });
  const bar = f.root.querySelectorAll<HTMLElement>(".spend-column")[29]!;
  bar.dispatchEvent(new f.window.Event("focus"));
  assert.match(
    f.root.querySelector(".spend-chart-detail")!.textContent!,
    /Live \$3.00.*Crons \$3.00.*Swarms \$0.50.*Webhooks \$0.00.*Monitors \$0.00/,
  );
  assert.equal(bar.querySelectorAll(".spend-segment").length, 5);
  assert.ok(!f.root.innerHTML.includes("NaN"));
  f.window.close();
});

test("spend chart: weekly bins preserve partial boundaries and zero spend is finite", () => {
  const { f } = render({
    ...DATA,
    window: { ...DATA.window, bucket: "week" },
    series: [{ day: "2026-08-24", live: { costUsd: 0 } }],
  });
  assert.equal(f.root.querySelectorAll(".spend-column").length, 5);
  assert.match(f.root.querySelector(".spend-column")!.getAttribute("aria-label")!, /Aug 26.*Aug 30/);
  assert.ok(!/NaN|Infinity/.test(f.root.innerHTML));
  f.window.close();
});

test("spend chart: model stacks use each bucket, retain gaps, and switch back to categories", () => {
  const data = {
    ...DATA,
    series: DATA.series.map((p, i) => ({
      ...p,
      models:
        i === 0
          ? [
              { model: "model-a", costUsd: 2 },
              { model: "model-b", costUsd: 4 },
            ]
          : [
              { model: "model-a", costUsd: 7 },
              { model: null, costUsd: 3 },
            ],
    })),
  };
  const { f, calls } = render(data);
  const bars = () => f.root.querySelectorAll<HTMLElement>(".spend-column");
  assert.match(f.root.querySelector(".spend-chart-plot")!.getAttribute("aria-label")!, /by model/);
  assert.match(bars()[28]!.getAttribute("aria-label")!, /model-a \$2.00.*model-b \$4.00.*Unknown model \$0.00/);
  assert.match(bars()[29]!.getAttribute("aria-label")!, /model-a \$7.00.*model-b \$0.00.*Unknown model \$3.00/);
  assert.deepEqual(
    [...bars()[29]!.querySelectorAll<HTMLElement>(".spend-segment")].map((s) => s.style.height),
    ["70%", "0%", "30%"],
  );
  assert.match(bars()[0]!.getAttribute("aria-label")!, /\$0.00 total/);
  bars()[29]!.dispatchEvent(new f.window.Event("focus"));
  assert.match(f.root.querySelector(".spend-chart-detail")!.textContent!, /model-a \$7.00/);
  calls.shell.search.onInput("alice");
  assert.match(f.root.querySelector(".spend-chart-plot")!.getAttribute("aria-label")!, /by model/);
  const toggle = (label: string) =>
    [...f.root.querySelectorAll<HTMLElement>(".spend-chart-switch button")].find(
      (b) => b.textContent!.trim() === label,
    )!;
  toggle("Category").click();
  assert.equal(toggle("Category").getAttribute("aria-pressed"), "true");
  assert.equal(bars()[29]!.querySelectorAll(".spend-live").length, 1);
  assert.match(bars()[29]!.getAttribute("aria-label")!, /Live \$10.00/);
  assert.doesNotMatch(f.root.querySelector(".spend-chart-detail")!.textContent!, /model-a/);
  toggle("Model").click();
  assert.equal(toggle("Model").getAttribute("aria-pressed"), "true");
  assert.equal(bars()[29]!.querySelectorAll(".spend-model").length, 3);
  assert.equal(calls.api, 0);
  f.window.close();
});

test("spend chart: weekly model stacks and zero totals remain finite", () => {
  const { f } = render({
    ...DATA,
    window: { ...DATA.window, bucket: "week" },
    series: [{ day: "2026-08-24", models: [{ model: null, costUsd: 0 }] }],
  });
  assert.equal(f.root.querySelectorAll(".spend-column").length, 5);
  assert.match(
    f.root.querySelector(".spend-column")!.getAttribute("aria-label")!,
    /Aug 26.*Aug 30.*Unknown model \$0.00/,
  );
  assert.ok(!/NaN|Infinity/.test(f.root.innerHTML));
  f.window.close();
});

for (const bucket of ["day", "week"]) {
  test(`spend chart: ${bucket} person toggle shows names, shared scopes and zero bins`, () => {
    const { f, calls, view } = render({
      ...DATA,
      window: { ...DATA.window, bucket },
      people: [person("alice", 3, { displayName: "Alice" }), person("bob", 2)],
      series: [
        {
          day: bucket === "day" ? "2026-09-24" : "2026-09-21",
          live: { costUsd: 10 },
          models: [{ model: "model-a", costUsd: 10 }],
          people: [
            { principalId: "alice", costUsd: 3 },
            { principalId: "bob", costUsd: 2 },
            { principalId: null, costUsd: 5 },
          ],
        },
      ],
    });
    const toggle = (label: string) =>
      [...f.root.querySelectorAll<HTMLButtonElement>(".spend-chart-switch button")].find(
        (b) => b.textContent!.trim() === label,
      )!;
    toggle("Person").click();
    assert.equal(toggle("Person").getAttribute("aria-pressed"), "true");
    const bars = () => f.root.querySelectorAll<HTMLElement>(".spend-column");
    assert.equal(bars().length, bucket === "day" ? 30 : 5);
    assert.match(
      bars()[0]!.getAttribute("aria-label")!,
      /\$0.00 total.*Alice \$0.00.*bob \$0.00.*Shared scopes \$0.00/,
    );
    const last = () => bars()[bars().length - 1]!;
    last().dispatchEvent(new f.window.Event("focus"));
    assert.match(
      f.root.querySelector(".spend-chart-detail")!.textContent!,
      /\$10.00 total.*Alice \$3.00.*bob \$2.00.*Shared scopes \$5.00/,
    );
    const colors = () => [...last().querySelectorAll<HTMLElement>(".spend-person")].map((s) => s.style.background);
    const before = colors();
    view.data.people[0].displayName = "Renamed Alice";
    calls.shell.search.onInput("unmatched");
    assert.deepEqual(colors(), before, "colors are stable across display-name changes and filtering");
    assert.deepEqual(
      [...last().querySelectorAll<HTMLElement>(".spend-segment")].map((s) => s.style.height),
      ["30%", "20%", "50%"],
    );
    for (const label of ["Category", "Model", "Person"]) {
      toggle(label).click();
      assert.equal(toggle(label).getAttribute("aria-pressed"), "true");
      assert.match(last().getAttribute("aria-label")!, /\$10.00 total/);
    }
    assert.ok(!/NaN|Infinity/.test(f.root.innerHTML));
    assert.equal(calls.api, 0);
    f.window.close();
  });
}

test("spend chart: person toggle is disabled for reports without person buckets", () => {
  const { f } = render(DATA);
  assert.equal(
    [...f.root.querySelectorAll<HTMLButtonElement>(".spend-chart-switch button")].find(
      (b) => b.textContent!.trim() === "Person",
    )!.disabled,
    true,
  );
  f.window.close();
});
