import type { Principal, ScopeId } from "../types.ts";
import { scopeId } from "../types.ts";
import type { ScopedConfigStore } from "./config-store.ts";

function principalScopes(p: Principal, orgScope: ScopeId, contextScope?: ScopeId): ScopeId[] {
  return [
    ...new Set(
      [orgScope, contextScope, scopeId("personal", p.id), ...(p.teamIds ?? []).map((t) => scopeId("team", t))].filter(
        (s): s is ScopeId => !!s,
      ),
    ),
  ];
}

function principalHosts(
  field: "allowedHosts" | "deniedHosts",
  p: Principal,
  config: ScopedConfigStore,
  orgScope: ScopeId,
  contextScope?: ScopeId,
): Set<string> {
  return new Set(principalScopes(p, orgScope, contextScope).flatMap((s) => config.setting("egress", s)?.[field] ?? []));
}

export function audienceEgressFloor(
  audience: Principal[],
  config: ScopedConfigStore,
  orgScope: ScopeId,
  contextScope?: ScopeId,
): string[] {
  if (audience.length === 0) return [];
  const sets = audience.map((p) => principalHosts("allowedHosts", p, config, orgScope, contextScope));
  const [first, ...rest] = sets;
  return [...(first ?? new Set<string>())].filter((h) => rest.every((s) => s.has(h)));
}

export function audienceDeniedFloor(
  audience: Principal[],
  config: ScopedConfigStore,
  orgScope: ScopeId,
  contextScope?: ScopeId,
): string[] {
  const out = new Set<string>();
  for (const p of audience)
    for (const h of principalHosts("deniedHosts", p, config, orgScope, contextScope)) out.add(h);
  return [...out];
}
