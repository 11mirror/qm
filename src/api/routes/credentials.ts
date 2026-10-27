import { brokerCredentialCall, brokerSinks, realBrokerFetch } from "../credential-broker.ts";
import { type ApiCtx, reply, type Route, type RouteResult } from "./route.ts";
import { tenant } from "../../tenant.ts";

async function brokerCredential(ctx: ApiCtx): Promise<RouteResult> {
  const { deps, body, capability } = ctx;
  if (!deps.serviceCreds) return reply(404, { error: "not_found" });
  const result = await brokerCredentialCall({
    claims: capability!,
    body: body as Record<string, unknown>,
    orgScopeId: tenant().orgScope,
    reader: deps.serviceCreds,
    fetchImpl: deps.brokerFetch ?? realBrokerFetch,
    ...brokerSinks(deps),
  });
  return reply(result.status, result.json);
}

export const credentialRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/credentials/broker", auth: { aud: "credential-broker" }, handle: brokerCredential },
];
