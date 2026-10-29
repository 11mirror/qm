import { litFixture } from "./admin-fixture.ts";

const zero = { costUsd: 0, calls: 0, tokens: 0 };

export const background = (sources: Record<string, number> = {}) => {
  const all = Object.fromEntries(
    ["cron", "swarm", "webhook", "monitor"].map((source) => [source, { ...zero, costUsd: sources[source] ?? 0 }]),
  );
  return { ...zero, costUsd: Object.values(sources).reduce((a, b) => a + b, 0), sources: all };
};

export const person = (principalId: string, costUsd: number, over: Record<string, any> = {}) => ({
  principalId,
  scopeId: `personal:${principalId}`,
  kind: "person",
  displayName: "",
  costUsd,
  calls: 2,
  tokens: 1000,
  input: 100,
  output: 100,
  cacheRead: 700,
  cacheWrite: 100,
  cacheHitRatio: 0.7,
  live: { costUsd, calls: 2, tokens: 1000 },
  background: background(),
  ...over,
});

export const DATA = {
  window: { from: "2026-08-26", to: "2026-09-25", bucket: "day" },
  org: {
    costUsd: 16,
    calls: 8,
    tokens: 4000,
    input: 400,
    output: 400,
    cacheRead: 2800,
    cacheWrite: 400,
    cacheHitRatio: 0.7,
    live: { costUsd: 16, calls: 8, tokens: 4000 },
    background: background(),
  },
  series: [
    { day: "2026-09-23", costUsd: 6, calls: 4, live: { costUsd: 6 }, background: background() },
    {
      day: "2026-09-24",
      costUsd: 10,
      calls: 4,
      live: { costUsd: 10 },
      background: background(),
    },
  ],
  people: [person("alice", 5), person("bob", 10), person("carol", 1)],
  scopes: [person("", 0, { principalId: null, scopeId: "channel:C1", kind: "channel", displayName: "#general" })],
};

export const EMPTY = {
  window: { from: "2026-08-26", to: "2026-09-25", bucket: "day" },
  org: {
    costUsd: 0,
    calls: 0,
    tokens: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheHitRatio: null,
    live: { costUsd: 0, calls: 0, tokens: 0 },
    background: background(),
  },
  series: [],
  people: [],
  scopes: [],
};

export function render(data: any, services: Record<string, unknown> = {}) {
  const f = litFixture();
  const calls: any = { shell: null, ranges: [], customs: [], opened: [], downloads: 0, modelDownloads: 0, api: 0 };
  const view = f.ui.spend.spend(f.root, data, {
    window: { from: "2026-09-01", to: "2026-10-01", preset: "30d", bucket: "day" },
    defaultShell: (opts: any) => {
      calls.shell = opts;
    },
    api: () => {
      calls.api += 1;
      return Promise.resolve({ ok: true, data: {} });
    },
    shortName: String,
    openUser: (principal: string) => calls.opened.push(principal),
    setRange: (range: string) => calls.ranges.push(range),
    setCustomRange: (from: string, to: string) => calls.customs.push([from, to]),
    downloadCsv: (breakdown?: string) => {
      if (breakdown === "model") calls.modelDownloads += 1;
      else calls.downloads += 1;
    },
    ...services,
  });
  const peopleRows = () =>
    [...f.root.querySelectorAll(".tablewrap")[0]!.querySelectorAll("tbody tr")].map((r) =>
      r.querySelector("td")!.textContent!.trim(),
    );
  return { f, calls, view, peopleRows };
}
