import { orgId } from "../../config.ts";
import { readFinnyHealth } from "../../finny/health.ts";
import { scopeId } from "../../types.ts";
import { sendJson } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";

export const finnyHealthRoutes: ReadonlyArray<Route<ApiCtx>> = [
  {
    method: "GET",
    path: "/v1/finny/health",
    auth: "either",
    handle: async ({ res, deps }) => {
      const status = await readFinnyHealth({
        credentialReader: deps.serviceCreds,
        orgScopeId: scopeId("org", orgId()),
      });
      sendJson(res, 200, status);
    },
  },
];
