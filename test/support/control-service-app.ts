import { buildTestApp, type TestApp } from "./test-app.ts";
import { createControlService, type ControlService } from "../../src/api/control-service.ts";
import { scopeId, type ScopeId } from "../../src/types.ts";
import { CAPABILITY_TTL_MS, type CapabilityClaims } from "../../src/auth/capability-token.ts";
import { testConfig } from "./test-config.ts";

export const SECRET = "control-service-test";

export const D1 = {
  key: "k-dm",
  type: "slack",
  target: "D1",
  audienceScopeId: scopeId("personal", "U1"),
  label: "this DM",
} as const;

export const ROOM = {
  key: "k-room",
  type: "slack",
  target: "C9",
  audienceScopeId: scopeId("channel", "C9"),
  label: "#eng",
} as const;

export function claims(
  actorId: string,
  scope: ScopeId = scopeId("personal", actorId),
  extra: Partial<CapabilityClaims> = {},
): CapabilityClaims {
  const dm = { ...D1, audienceScopeId: scopeId("personal", actorId) };
  return {
    actorId,
    scopeId: scope,
    destination: { type: dm.type, target: dm.target, audienceScopeId: dm.audienceScopeId },
    destinations: [dm, ROOM],
    defaultDestinationKey: D1.key,
    exp: Date.now() + CAPABILITY_TTL_MS,
    ...extra,
  };
}

export function setup(): { built: TestApp; control: ControlService } {
  const built = buildTestApp(testConfig({ signingSecret: SECRET }));
  const control = createControlService(built.app, built.scheduler, built.admin);
  return { built, control };
}
