import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createUnavailableFinanceService } from "../src/finny/unavailable-finance-service.ts";
import { scopeId } from "../src/types.ts";
import { buildApp } from "../src/wiring.ts";
import { finnyTestStores } from "./support/finny-test-stores.ts";
import { createMockHarness } from "./support/mock-harness.ts";
import { testConfig } from "./support/test-config.ts";

const MODEL = "gpt-5.6-sol";
const SKILLS_DIR = fileURLToPath(new URL("../finny-skills", import.meta.url));

test("Finny security screening always uses its pinned Pi runtime", async (t) => {
  const claude = createMockHarness();
  let claudeCalls = 0;
  claude.models.screenSecurity = async () => {
    claudeCalls += 1;
    return { decision: "strict" };
  };
  let modelRequest: { model?: string } | undefined;
  const upstream = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    if (raw) modelRequest = JSON.parse(raw) as { model?: string };
    const text = JSON.stringify({ decision: "auto" });
    const item = {
      id: "msg_screen",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    const events = [
      { type: "response.created", response: { id: "resp_screen", model: MODEL, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: "resp_screen",
          model: MODEL,
          status: "completed",
          output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });
  const address = upstream.address() as AddressInfo;
  const built = buildApp(
    testConfig({
      harness: "pi",
      modelId: MODEL,
      finnyProfile: { id: "finny", modelId: MODEL, skillsDir: SKILLS_DIR },
      modelGateway: {
        url: `http://127.0.0.1:${address.port}`,
        apiKey: "gateway-test-key",
        apiKeyHeader: "x-gateway-key",
        models: { [MODEL]: "finny-pinned" },
      },
    }),
    {
      ...finnyTestStores(),
      finnyFinanceService: createUnavailableFinanceService(),
      harnesses: { claude },
    },
  );
  t.after(() => built.runtime.stop());

  assert.deepEqual(
    await built.screenSecurity!({
      payload: "quarterly data",
      harnessId: "claude",
      modelId: "claude-opus-5-5",
      systemPrompt: "screen this",
      actorId: "alice",
      scopeLabel: scopeId("org", "local"),
      signal: AbortSignal.timeout(5_000),
    }),
    { decision: "auto" },
  );
  assert.equal(claudeCalls, 0);
  assert.equal(modelRequest?.model, "finny-pinned");
});
