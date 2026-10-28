import type { Config } from "../../src/config.ts";
import type { AclStore } from "../../src/acl/acl-store.ts";
import { encodeRef, serviceCredRef } from "../../src/acl/resource-ref.ts";
import type { Sandbox } from "../../src/sandbox/sandbox.ts";
import type { RunActivityEntry } from "../../src/runs/postgres-run-activity-store.ts";
import type { Item } from "../../src/sessions/items.ts";
import type { SecurityScreener } from "../../src/security/security-screener.ts";
import assert from "node:assert/strict";
import type { ScopeId, TurnRequest, TurnResult } from "../../src/types.ts";
import { hashId } from "../../src/util/crypto.ts";
import { selectDefaultSandbox } from "./default-sandbox.ts";
import { buildTestApp as buildRecordingApp } from "./test-app.ts";
import { testConfig } from "./test-config.ts";

export const noDefaultSandbox = new WeakSet<object>();

function requestScope(req: TurnRequest): ScopeId | null {
  const c = req.conversation;
  if (c.kind === "dm") return `personal:${req.actor.externalId}` as ScopeId;
  if ((c.kind === "channel" || c.kind === "group") && c.channelRef) return `${c.kind}:${c.channelRef}` as ScopeId;
  return null;
}

export function buildTestApp(...args: Parameters<typeof buildRecordingApp>) {
  const built = buildRecordingApp(...args);
  const ready = new Map<string, Promise<void>>();
  const ensure = (actorId: string, scope: ScopeId) => {
    let p = ready.get(scope);
    if (!p) {
      p = (async () => {
        if (noDefaultSandbox.has(built)) return;
        if (await built.sandboxResources.resolve(scope)) return;
        await selectDefaultSandbox(built, actorId, scope);
      })();
      ready.set(scope, p);
    }
    return p;
  };
  const turn = built.app.turn.bind(built.app);
  built.app.turn = async (req, ...rest) => {
    const scope = requestScope(req);
    if (scope) await ensure(req.actor.externalId, scope);
    return turn(req, ...rest);
  };
  return built;
}

export function freshApp(overrides: Partial<Config> = {}, securityScreener?: SecurityScreener) {
  const config = testConfig(overrides);
  config.sandbox.namePrefix ??= `test-${hashId([config.dataDir]).slice(0, 10)}`;
  return buildTestApp(config, securityScreener ? { securityScreener } : {});
}

export async function failedTurn(
  built: ReturnType<typeof freshApp>,
  request: TurnRequest,
  reason: RegExp,
): Promise<TurnResult> {
  const result = await built.app.turn(request);
  assert.equal(result.status, "failed", JSON.stringify(result));
  await built.errors.flush();
  const logged = await built.errors.list({ sessionId: result.sessionId! });
  assert.ok(
    logged.some((e) => reason.test(e.message)),
    `expected a recorded failure matching ${reason}: ${JSON.stringify(logged.map((e) => e.message))}`,
  );
  return result;
}

export function spyProvisioning(sandbox: Sandbox) {
  const counts = { provisioned: 0, live: 0 };
  const provision = sandbox.provision.bind(sandbox);
  const teardown = sandbox.teardown.bind(sandbox);
  sandbox.provision = async (layers, opts) => {
    counts.provisioned++;
    counts.live++;
    return provision(layers, opts);
  };
  sandbox.teardown = async (handle, opts) => {
    await teardown(handle, opts);
    counts.live--;
  };
  return counts;
}

export const internalActor = { externalId: "U1" };

export function dm(text: string, extra: Partial<TurnRequest> = {}): TurnRequest {
  return {
    surface: "test",
    actor: internalActor,
    conversation: { kind: "dm", threadRef: "dm:U1:t1" },
    text,
    origin: { kind: "direct" },
    ...extra,
  };
}

export function channel(text: string, extra: Partial<TurnRequest> = {}): TurnRequest {
  return {
    surface: "slack",
    actor: internalActor,
    conversation: { kind: "channel", threadRef: "ch:C1:t1", channelRef: "C1", audience: [internalActor] },
    text,
    gatewayContext: { reactionGuidance: "react with a Slack emoji short-name like :pray:" },
    origin: { kind: "direct" },
    ...extra,
  };
}

export async function grantCred(acl: AclStore, org: ScopeId, slug: string, grantee: ScopeId = org): Promise<void> {
  await acl.grant({
    ownerScopeId: org,
    ref: encodeRef(serviceCredRef(slug)),
    granteeScopeId: grantee,
    permission: "read",
    grantedBy: "admin@default-org",
  });
}

export const activityItems = (activity: RunActivityEntry[] | undefined): Item[] =>
  (activity ?? []).flatMap((entry) => ("item" in entry ? [entry.item] : []));
