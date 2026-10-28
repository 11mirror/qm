import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPiHarness, piHarnessConfigOptions } from "../src/harness/pi-harness.ts";
import { loadConfig } from "../src/config.ts";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { classifiedMemory } from "../src/memory/classification.ts";
import { createPerTurnStrategy } from "../src/memory/strategies/per-turn.ts";
import {
  DEFAULT_STRATEGY_FLOORS,
  floorFailures,
  formatTable,
  JUDGE_PROMPT,
  parseBenchConversation,
  parseJudgeVerdict,
  renderJudgeInput,
  replayConversation,
  summarize,
  type BenchResult,
} from "../src/memory/bench.ts";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY not set — the benchmark replays extraction and judges with a live model.");
  process.exit(1);
}

const kind = "per-turn";

const fixtureDir = fileURLToPath(new URL("../test/memory-bench/conversations/", import.meta.url));
const conversations = readdirSync(fixtureDir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => parseBenchConversation(JSON.parse(readFileSync(join(fixtureDir, f), "utf8")), f));

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const config = loadConfig();
const harness = createPiHarness({
  ...piHarnessConfigOptions(config),
  ...(config.modelGateway ? { modelGateway: config.modelGateway } : {}),
  resolveProviderKeys: async () => ({
    ...(config.anthropicApiKey ? { anthropic: config.anthropicApiKey } : {}),
    ...(config.openaiApiKey ? { openai: config.openaiApiKey } : {}),
    ...(config.openrouterApiKey ? { openrouter: config.openrouterApiKey } : {}),
  }),
  tempDirPrefix: "membench",
});
if (!harness.models.oneShot) {
  console.error("harness has no oneShot — cannot judge");
  process.exit(1);
}
const oneShot = harness.models.oneShot.bind(harness.models);

const results: BenchResult[] = [];
{
  for (const conversation of conversations) {
    const memory = createPostgresMemoryService(databaseUrl);
    const strategy = createPerTurnStrategy({
      harness: harness.models,
      memory: classifiedMemory(memory, harness.models),
    });
    const scopeId = `user:bench-${kind}-${conversation.id}-${Date.now()}`;
    await replayConversation(strategy, scopeId, conversation);
    const notebook = await memory.read(scopeId);
    const judgeOut = await oneShot(JUDGE_PROMPT, renderJudgeInput(conversation, notebook));
    const verdict = parseJudgeVerdict(judgeOut ?? "");
    results.push({ kind, conversationId: conversation.id, notebook, verdict });
    console.log(
      `[${kind}] ${conversation.id}: s/n=${verdict.signalToNoise} stale=${verdict.staleness} ` +
        `infer=${verdict.inferenceVsObservation} — ${verdict.notes}`,
    );
  }
}

const rows = summarize(results);
console.log(`\n${formatTable(rows)}\n`);

const outPath = process.env.MEMORY_BENCH_OUT;
if (outPath) {
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), rows, results }, null, 2));
  console.log(`report written to ${outPath}`);
}

const defaultRow = rows.find((r) => r.kind === kind);
if (defaultRow) {
  const failures = floorFailures(defaultRow);
  if (failures.length) {
    console.error(
      `memory capture is below its quality floors ` +
        `(${JSON.stringify(DEFAULT_STRATEGY_FLOORS)}): ${failures.join("; ")}`,
    );
    process.exit(2);
  }
}
