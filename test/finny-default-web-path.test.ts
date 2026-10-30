import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { createServer as createHttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createServer } from "../src/api/server.ts";
import type { AtomicFetchAdapter } from "../src/finny/credential-brokered-finance-service.ts";
import { digestFinnyEvidence } from "../src/finny/golden-loop.ts";
import { buildApp } from "../src/wiring.ts";
import { signedHeaders } from "../plugins/chassis/src/core-client.ts";
import { finnyTestStores } from "./support/finny-test-stores.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "finny-default-web-secret".repeat(2);
const MODEL = "gpt-5.6-sol";
const digest = (value: string) => digestFinnyEvidence(value);

function sendModelItem(res: ServerResponse, item: Record<string, unknown>, serial: number): void {
  const send = (type: string, data: object) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.writeHead(200, { "content-type": "text/event-stream" });
  send("response.created", {
    response: { id: `resp_${serial}`, model: MODEL, status: "in_progress", output: [] },
  });
  send("response.output_item.added", { output_index: 0, item });
  send("response.output_item.done", { output_index: 0, item });
  send("response.completed", {
    response: {
      id: `resp_${serial}`,
      model: MODEL,
      status: "completed",
      output: [item],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  });
  res.end();
}

test("default QM web path publishes and verifies a host-classified finance artifact", async (t) => {
  let step = 0;
  let sourceCalls = 0;
  const upstream = createHttpServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    if (!raw) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    JSON.parse(raw);
    const actions = [() => ({ request: "What is our AP balance?" })];
    const action = actions[step]?.();
    step += 1;
    const item = action
      ? {
          type: "function_call",
          id: `fc_${step}`,
          call_id: `call_${step}`,
          name: "finance",
          arguments: JSON.stringify(action),
          status: "completed",
        }
      : {
          type: "message",
          id: "msg_verified",
          role: "assistant",
          content: [{ type: "output_text", text: "Verified AP detail is attached.", annotations: [] }],
          status: "completed",
        };
    sendModelItem(res, item, step);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });

  const policyDigest = digest("read-only-policy");
  const atomicFetch: AtomicFetchAdapter = {
    async preflight() {
      return {
        planSummary: "read AP detail",
        preflightDigest: digest("preflight"),
        planDigest: digest("plan"),
        approvalRequired: false,
        approvalPolicyDigest: policyDigest,
      };
    },
    async source() {
      sourceCalls += 1;
      return {
        records: Array.from({ length: 11 }, (_, index) => ({ id: index + 1, amount: index + 10 })),
        sourceDigest: digest(`upstream-${sourceCalls}`),
      };
    },
  };
  const built = buildApp(
    testConfig({
      harness: "pi",
      modelId: MODEL,
      finnyProfile: { id: "finny", modelId: MODEL, providerTimeoutMs: 120_000 },
      securityScreen: "off",
      modelGateway: {
        url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
        apiKey: "gateway-test-key",
        apiKeyHeader: "x-gateway-key",
        models: { [MODEL]: MODEL },
      },
    }),
    { finnyAtomicFetchAdapter: atomicFetch, ...finnyTestStores() },
  );
  t.after(() => built.runtime.stop());
  await built.serviceCreds.setServiceCredential("org:default-org", {
    slug: "finny-hindsight",
    name: "Finny Hindsight",
    secret: "hindsight-test-secret",
    host: "hindsight.internal",
  });
  await built.serviceCreds.setServiceCredential("org:default-org", {
    slug: "finny-netsuite",
    name: "Finny NetSuite",
    secret: "netsuite-test-secret",
    host: "netsuite.internal",
  });
  const core = createServer(built.app, { signingSecret: SECRET, runs: built.runs, sessions: built.sessions });
  await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    core.closeAllConnections();
    core.close();
  });
  const base = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
  const path = "/v1/turns";
  const body = JSON.stringify({
    surface: "web",
    actor: { externalId: "internal:finny-default-web" },
    conversation: { kind: "dm", threadRef: "finny-default-web" },
    text: "What is our AP balance?",
    skipMemory: true,
  });

  const response = await fetch(base + path, {
    method: "POST",
    headers: { ...signedHeaders(SECRET, "POST", path, body), "content-type": "application/json" },
    body,
  });
  assert.equal(response.status, 200);
  const result = (await response.json()) as { reply?: string };
  assert.equal(result.reply, "Verified AP detail is attached.");
  assert.equal(sourceCalls, 2);
  const files = await built.files.listOwnedByScopes(["personal:internal:finny-default-web"]);
  assert.equal(files.files.length, 1);
  assert.equal(files.files[0]?.mimetype, "text/csv");
});
