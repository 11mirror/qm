import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { createServer as createHttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createServer } from "../src/api/server.ts";
import type { FinanceService } from "../src/finny/finance.ts";
import { applyFinnyHostEvent, digestFinnyEvidence, replayFinnyLedger } from "../src/finny/golden-loop.ts";
import { createUnavailableFinanceService } from "../src/finny/unavailable-finance-service.ts";
import { buildApp } from "../src/wiring.ts";
import { signedHeaders } from "../plugins/chassis/src/core-client.ts";
import { finnyTestStores } from "./support/finny-test-stores.ts";
import { createMockHarness } from "./support/mock-harness.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "finny-web-source-secret".repeat(2);
const MODEL = "gpt-5.6-sol";
const SKILLS_DIR = fileURLToPath(new URL("../finny-skills", import.meta.url));
const digest = (value: string) => digestFinnyEvidence(value);
const AP_CANDIDATE = {
  capabilityId: "ap_gl_control_balance",
  dimensions: {
    entity: "all",
    period: "current",
    currency: "source_base",
    grain: "total",
    artifact: "optional",
  },
};

function sendResponse(res: ServerResponse, body: Record<string, unknown>): void {
  const toolResult = Array.isArray(body.input)
    ? body.input.some((item) => item && typeof item === "object" && item.type === "function_call_output")
    : false;
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const hasFinance = tools.some(
    (item) => item && typeof item === "object" && "name" in item && item.name === "finance",
  );
  const item =
    hasFinance && !toolResult
      ? {
          type: "function_call",
          id: "fc_finny_clarify",
          call_id: "call_finny_clarify",
          name: "finance",
          arguments: JSON.stringify(AP_CANDIDATE),
          status: "completed",
        }
      : {
          type: "message",
          id: "msg_finny",
          role: "assistant",
          content: [{ type: "output_text", text: "UNVERIFIED AP IS 42", annotations: [] }],
          status: "completed",
        };
  const send = (type: string, data: object) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.writeHead(200, { "content-type": "text/event-stream" });
  send("response.created", { response: { id: "resp_finny", model: MODEL, status: "in_progress", output: [] } });
  send("response.output_item.added", { output_index: 0, item });
  send("response.output_item.done", { output_index: 0, item });
  send("response.completed", {
    response: {
      id: "resp_finny",
      model: MODEL,
      status: "completed",
      output: [item],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  });
  res.end();
}

test("QM web ingress runs the Pi-native finance tool and host-blocks an unverified answer with a safe trace", async (t) => {
  const modelRequests: Array<Record<string, unknown>> = [];
  const upstream = createHttpServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    modelRequests.push(body);
    assert.equal(req.headers["x-gateway-key"], "gateway-test-key");
    sendResponse(res, body);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });
  const upstreamAddress = upstream.address() as AddressInfo;
  const built = buildApp(
    testConfig({
      harness: "pi",
      modelId: MODEL,
      finnyProfile: { id: "finny", modelId: MODEL, skillsDir: SKILLS_DIR },
      securityScreen: "off",
      modelGateway: {
        url: `http://127.0.0.1:${upstreamAddress.port}`,
        apiKey: "gateway-test-key",
        apiKeyHeader: "x-gateway-key",
        models: { [MODEL]: MODEL },
      },
    }),
    { finnyFinanceService: createUnavailableFinanceService(), ...finnyTestStores() },
  );
  t.after(() => built.runtime.stop());
  const core = createServer(built.app, {
    signingSecret: SECRET,
    runs: built.runs,
    sessions: built.sessions,
  });
  await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    core.closeAllConnections();
    core.close();
  });
  const base = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
  const path = "/v1/turns";
  const body = JSON.stringify({
    surface: "web",
    actor: { externalId: "internal:finny-web-tester" },
    conversation: { kind: "dm", threadRef: "finny-web-validation" },
    text: "What is the AP balance?",
    skipMemory: true,
  });

  const response = await fetch(base + path, {
    method: "POST",
    headers: { ...signedHeaders(SECRET, "POST", path, body), "content-type": "application/json" },
    body,
  });
  assert.equal(response.status, 200);
  const result = (await response.json()) as {
    status?: string;
    reply?: string;
    runtime?: { harnessId?: string; modelId?: string };
  };
  assert.equal(result.status, "ok");
  assert.match(result.reply ?? "", /blocked at PREFLIGHT/i);
  assert.doesNotMatch(result.reply ?? "", /UNVERIFIED AP IS 42/);
  assert.equal(result.runtime?.harnessId, "pi");
  assert.equal(result.runtime?.modelId, MODEL);
  assert.ok(
    modelRequests.some(
      (request) =>
        Array.isArray(request.tools) &&
        request.tools.some((item) => item && typeof item === "object" && "name" in item && item.name === "finance"),
    ),
  );

  const recorded = await built.runs.latestForThread("finny-web-validation");
  assert.equal(recorded?.status, "done");
  const eventsPath = `/v1/runs/${recorded!.id}/events`;
  const events = await fetch(base + eventsPath, { headers: signedHeaders(SECRET, "GET", eventsPath) });
  assert.equal(events.status, 200);
  const wire = await events.text();
  assert.match(wire, /"schema":"finny\.trace\.v3"/);
  assert.match(wire, /"harness":"pi"/);
  assert.match(wire, /"stage":"PREFLIGHT"/);
  assert.match(wire, /"outcome":"blocked"/);
  assert.doesNotMatch(wire, /gateway-test-key/);

  const tracePath = `/v1/runs/${recorded!.id}/finny-trace`;
  const traceResponse = await fetch(base + tracePath, { headers: signedHeaders(SECRET, "GET", tracePath) });
  assert.equal(traceResponse.status, 200);
  const trace = (await traceResponse.json()) as { trace?: Record<string, unknown> };
  assert.equal(trace.trace?.schema, "finny.trace.v3");
  assert.equal(trace.trace?.currentRunId, recorded!.id);
  assert.equal(trace.trace?.harness, "pi");
  assert.equal(trace.trace?.modelId, MODEL);
  assert.equal(trace.trace?.stage, "PREFLIGHT");
  assert.equal(trace.trace?.outcome, "blocked");
  assert.doesNotMatch(JSON.stringify(trace), /gateway-test-key|UNVERIFIED AP IS 42/);
});

test("QM web approval resumes the same Pi-native Golden Loop and releases only verified web output", async (t) => {
  let actionIndex = 0;
  let callSerial = 0;
  const actions = [AP_CANDIDATE, AP_CANDIDATE];
  const upstream = createHttpServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const hasFinance = tools.some(
      (item) => item && typeof item === "object" && "name" in item && item.name === "finance",
    );
    let item: Record<string, unknown>;
    if (hasFinance && actionIndex < actions.length) {
      const action = actions[actionIndex++]!;
      callSerial += 1;
      item = {
        type: "function_call",
        id: `fc_finny_${callSerial}`,
        call_id: `call_finny_${callSerial}`,
        name: "finance",
        arguments: JSON.stringify(action),
        status: "completed",
      };
    } else {
      item = {
        type: "message",
        id: "msg_verified_finny",
        role: "assistant",
        content: [{ type: "output_text", text: "VERIFIED AP IS 42", annotations: [] }],
        status: "completed",
      };
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (type: string, data: object) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send("response.created", {
      response: { id: `resp_${actionIndex}`, model: MODEL, status: "in_progress", output: [] },
    });
    send("response.output_item.added", { output_index: 0, item });
    send("response.output_item.done", { output_index: 0, item });
    send("response.completed", {
      response: {
        id: `resp_${actionIndex}`,
        model: MODEL,
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    });
    res.end();
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });
  const stores = finnyTestStores();
  const service: FinanceService = {
    async clarify() {
      return { clarification: "entity and period pinned", evidenceDigest: digest("clarified") };
    },
    async executeOperation() {
      throw new Error("sourcePlan owns test operation custody");
    },
    async recoverSource() {
      return { records: [{ total: 42 }] };
    },
    async sourcePlan({ plan }, context) {
      const checkpoint = await stores.finnyRunStore.load(context.runId);
      if (!checkpoint) throw new Error("Finny run checkpoint is unavailable");
      let state = replayFinnyLedger(context.runId, checkpoint.ledger);
      for (const operation of plan.operations) {
        state = applyFinnyHostEvent(state, {
          authority: "qm-host",
          eventId: `${context.runId}:operation:${operation.id}`,
          occurredAt: "2026-10-30T10:00:00.000Z",
          kind: "operation_completed",
          operationId: operation.id,
          primitive: operation.primitive,
          operationDigest: digest(`operation:${plan.planDigest}:${operation.id}`),
          resultDigest: digest(`result:${plan.planDigest}:${operation.id}`),
        });
        await stores.finnyRunStore.checkpoint(context.runId, state.ledger.at(-1)!);
      }
      return { records: [{ total: 42 }], sourceDigest: digest("source") };
    },
    async artifact() {
      return { requirement: "optional", policyDigest: digest("artifact-policy") };
    },
    async verify() {
      return { passed: true, verificationDigest: digest("verified") };
    },
  };
  const built = buildApp(
    testConfig({
      harness: "pi",
      modelId: MODEL,
      finnyProfile: { id: "finny", modelId: MODEL, skillsDir: SKILLS_DIR },
      securityScreen: "off",
      modelGateway: {
        url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
        apiKey: "gateway-test-key",
        apiKeyHeader: "x-gateway-key",
        models: { [MODEL]: MODEL },
      },
    }),
    { finnyFinanceService: service, ...stores },
  );
  t.after(() => built.runtime.stop());
  const core = createServer(built.app, { signingSecret: SECRET, runs: built.runs, sessions: built.sessions });
  await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    core.closeAllConnections();
    core.close();
  });
  const base = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
  const path = "/v1/turns";
  const request = {
    surface: "web",
    actor: { externalId: "internal:finny-approval-tester" },
    conversation: { kind: "dm", threadRef: "finny-web-approval" },
    text: "What is the AP balance?",
    skipMemory: true,
  };
  const post = async (value: Record<string, unknown>) => {
    const raw = JSON.stringify(value);
    const response = await fetch(base + path, {
      method: "POST",
      headers: { ...signedHeaders(SECRET, "POST", path, raw), "content-type": "application/json" },
      body: raw,
    });
    assert.equal(response.status, 200);
    return response.json() as Promise<{
      status: string;
      reply?: string;
      pendingApprovals?: Array<{ requestId: string }>;
    }>;
  };

  const blocked = await post(request);
  assert.equal(blocked.status, "ok");
  assert.match(blocked.reply ?? "", /blocked at PREFLIGHT/i);
  assert.equal(blocked.pendingApprovals?.length, 1);
  assert.equal(actionIndex, 1);

  const released = await post({
    ...request,
    approval: { requestId: blocked.pendingApprovals![0]!.requestId, approved: true },
  });
  assert.equal(released.status, "ok");
  assert.equal(
    released.reply,
    `Finny verified this finance result:\n\n[\n  {\n    "total": 42\n  }\n]\n\nSource evidence: ${digest("source")}\nVerification evidence: ${digest("verified")}`,
  );
  assert.doesNotMatch(released.reply ?? "", /VERIFIED AP IS 42/);

  const recorded = await built.runs.latestForThread("finny-web-approval");
  assert.equal(recorded?.status, "done");
  const tracePath = `/v1/runs/${recorded!.id}/finny-trace`;
  const traceResponse = await fetch(base + tracePath, { headers: signedHeaders(SECRET, "GET", tracePath) });
  assert.equal(traceResponse.status, 200);
  const trace = (await traceResponse.json()) as { trace: Record<string, unknown> };
  assert.equal(trace.trace.stage, "DELIVERY_ELIGIBLE");
  assert.equal(trace.trace.outcome, "web_only_unattested");
  assert.equal(trace.trace.harness, "pi");
});

test("Finny rejects a runtime-pinned Claude choice before the Claude adapter runs", async () => {
  let claudeCalls = 0;
  const claude = createMockHarness();
  const runClaudeTurn = claude.turns.runTurn;
  claude.turns.runTurn = async (input) => {
    claudeCalls += 1;
    return runClaudeTurn(input);
  };
  const built = buildApp(
    testConfig({
      harness: "pi",
      modelId: MODEL,
      finnyProfile: { id: "finny", modelId: MODEL, skillsDir: SKILLS_DIR },
    }),
    { harnesses: { claude }, ...finnyTestStores() },
  );
  await built.config.setApprovedHarnesses(["pi", "claude"]);
  await built.userModelCredentials.setOAuth("finny-pinned", "anthropic", {
    accessToken: "personal-claude-oauth",
    expiresAt: Date.now() + 3_600_000,
  });
  await built.config.setPersonalModelAuth("finny-pinned", true, "anthropic");
  const submitted = await built.app.turn({
    surface: "web",
    actor: { externalId: "finny-pinned" },
    conversation: { kind: "dm", threadRef: "finny-runtime-pinned-claude" },
    text: "What is the AP balance?",
    model: "claude-sonnet-5",
    harness: "claude",
    liveActor: true,
    async: true,
  });
  assert.deepEqual(submitted, { status: "refused", reason: "runtime_constraint_mismatch" });
  assert.equal(await built.runs.latestForThread("finny-runtime-pinned-claude"), null);
  assert.equal(claudeCalls, 0);
});

test("Finny ignores a stored Claude runtime and runs the pinned Pi model", async (t) => {
  let claudeCalls = 0;
  const claude = createMockHarness();
  claude.turns.runTurn = async () => {
    claudeCalls += 1;
    return { reply: "wrong adapter" };
  };
  const upstream = createHttpServer(async (req, res) => {
    for await (const _chunk of req) void _chunk;
    const item = {
      type: "message",
      id: "msg_finny_pinned",
      role: "assistant",
      content: [{ type: "output_text", text: "Pinned Pi reply", annotations: [] }],
      status: "completed",
    };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_finny_pinned", model: MODEL, status: "in_progress", output: [] } })}\n\n`,
    );
    res.write(
      `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item })}\n\n`,
    );
    res.write(
      `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\n`,
    );
    res.write(
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_finny_pinned", model: MODEL, status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } })}\n\n`,
    );
    res.end();
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });
  const built = buildApp(
    testConfig({
      anthropicApiKey: "company-anthropic",
      harness: "pi",
      modelId: MODEL,
      finnyProfile: { id: "finny", modelId: MODEL, skillsDir: SKILLS_DIR },
      modelGateway: {
        url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
        apiKey: "gateway-test-key",
        apiKeyHeader: "x-gateway-key",
        models: { [MODEL]: MODEL },
      },
    }),
    { harnesses: { claude }, ...finnyTestStores() },
  );
  await built.config.setApprovedHarnesses(["pi", "claude"]);
  await built.config.setRuntimeSelection("personal:finny-stored", {
    harnessId: "claude",
    modelId: "claude-sonnet-5",
  });
  const submitted = await built.app.turn({
    surface: "web",
    actor: { externalId: "finny-stored" },
    conversation: { kind: "dm", threadRef: "finny-stored-claude" },
    text: "Say hello.",
    liveActor: true,
    async: true,
  });
  assert.ok(submitted.runId, JSON.stringify(submitted));
  built.runtime.start();
  try {
    const finished = await built.runs.waitFor(submitted.runId!, 5_000);
    assert.equal(finished.status, "done");
    assert.equal(finished.result?.runtime?.harnessId, "pi");
    assert.equal(finished.result?.runtime?.modelId, MODEL);
    assert.equal(claudeCalls, 0);
  } finally {
    await built.runtime.stop();
  }
});

for (const provider of ["anthropic", "openai"] as const) {
  const recovery =
    provider === "anthropic"
      ? {
          label: "triggered automation with stale Claude metadata",
          request: {
            origin: { kind: "automation" as const },
            triggered: true,
            modelAccount: provider,
            harness: "claude" as const,
            model: "claude-sonnet-5",
          },
        }
      : {
          label: "persisted personal run with an unknown retired harness",
          request: {
            modelAccount: provider,
            harness: "retired-harness" as never,
            model: "retired-model",
          },
        };
  test(`Finny recovers a ${recovery.label} onto the pinned deployment model`, async (t) => {
    let claudeCalls = 0;
    let gatewayCalls = 0;
    const claude = createMockHarness();
    claude.turns.runTurn = async () => {
      claudeCalls += 1;
      return { reply: "wrong adapter" };
    };
    const upstream = createHttpServer(async (req, res) => {
      for await (const _chunk of req) void _chunk;
      gatewayCalls += 1;
      const item = {
        type: "message",
        id: `msg_finny_personal_${provider}`,
        role: "assistant",
        content: [{ type: "output_text", text: `Pinned ${provider} deployment reply`, annotations: [] }],
        status: "completed",
      };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: `resp_finny_personal_${provider}`, model: MODEL, status: "in_progress", output: [] } })}\n\n`,
      );
      res.write(
        `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item })}\n\n`,
      );
      res.write(
        `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\n`,
      );
      res.write(
        `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: `resp_finny_personal_${provider}`, model: MODEL, status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } })}\n\n`,
      );
      res.end();
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      upstream.closeAllConnections();
      upstream.close();
    });
    const actor = `finny-personal-${provider}`;
    const threadRef = `finny-personal-${provider}-deployment`;
    const built = buildApp(
      testConfig({
        harness: "pi",
        modelId: MODEL,
        finnyProfile: { id: "finny", modelId: MODEL, skillsDir: SKILLS_DIR },
        modelGateway: {
          url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
          apiKey: "gateway-test-key",
          apiKeyHeader: "x-gateway-key",
          models: { [MODEL]: MODEL },
        },
      }),
      { harnesses: { claude }, ...finnyTestStores() },
    );
    await built.userModelCredentials.setOAuth(actor, provider, {
      accessToken: `personal-${provider}-oauth`,
      expiresAt: Date.now() + 3_600_000,
    });
    await built.config.setPersonalModelAuth(actor, true, provider);
    const submitted = await built.app.turn({
      surface: "web",
      actor: { externalId: actor },
      conversation: { kind: "dm", threadRef },
      text: "Say hello.",
      liveActor: true,
      async: true,
    });
    assert.ok(submitted.runId, JSON.stringify(submitted));
    const queued = await built.runs.get(submitted.runId!);
    assert.ok(queued);
    assert.equal(queued.request.modelAccount, "company");
    assert.equal(await built.runs.withdraw(queued.id, { unstartedOnly: true }), true);
    const persisted = await built.runs.enqueue({
      sessionId: queued.sessionId,
      request: {
        ...queued.request,
        ...recovery.request,
      },
    });
    built.runtime.start();
    try {
      const finished = await built.runs.waitFor(persisted.run.id, 5_000);
      assert.equal(finished.status, "done", JSON.stringify(finished.result));
      assert.match(finished.result?.reply ?? "", /Finny release is blocked at CLARIFY/);
      assert.equal(finished.result?.runtime?.harnessId, "pi");
      assert.equal(finished.result?.runtime?.modelId, MODEL);
      assert.ok(gatewayCalls > 0);
      assert.equal(claudeCalls, 0);
    } finally {
      await built.runtime.stop();
    }
  });
}

test("ordinary runtime-pinned Claude routing still reaches the Claude adapter", async () => {
  let claudeCalls = 0;
  const claude = createMockHarness();
  claude.turns.runTurn = async () => {
    claudeCalls += 1;
    return { reply: "ordinary Claude reply" };
  };
  const built = buildApp(testConfig({ harness: "pi", modelId: MODEL }), { harnesses: { claude } });
  await built.config.setApprovedHarnesses(["pi", "claude"]);
  await built.userModelCredentials.setOAuth("ordinary-pinned", "anthropic", {
    accessToken: "personal-claude-oauth",
    expiresAt: Date.now() + 3_600_000,
  });
  await built.config.setPersonalModelAuth("ordinary-pinned", true, "anthropic");
  const submitted = await built.app.turn({
    surface: "web",
    actor: { externalId: "ordinary-pinned" },
    conversation: { kind: "dm", threadRef: "ordinary-runtime-pinned-claude" },
    text: "hello",
    model: "claude-sonnet-5",
    harness: "claude",
    liveActor: true,
    async: true,
  });
  assert.ok(submitted.runId, JSON.stringify(submitted));
  built.runtime.start();
  try {
    const finished = await built.runs.waitFor(submitted.runId!, 5_000);
    assert.equal(finished.status, "done", JSON.stringify(finished.result));
    assert.equal(claudeCalls, 1);
  } finally {
    await built.runtime.stop();
  }
});
