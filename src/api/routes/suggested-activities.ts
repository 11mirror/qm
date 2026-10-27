import { parseSuggestedActivities } from "../../../plugins/chassis/src/suggested-activities.ts";
import { fail } from "../http.ts";
import { isObj } from "./shared.ts";
import { ok, reply, type Route } from "./route.ts";

export const suggestedActivityRoutes: Route[] = [
  {
    method: "GET",
    path: "/v1/suggested-activities",
    auth: "source",
    handle: ({ deps }) => ok({ enabled: Boolean(deps.suggestedActivities) }),
  },
  {
    method: "POST",
    path: "/v1/suggested-activities",
    auth: "source",
    handle: async ({ deps, body, actor }) => {
      if (!deps.suggestedActivities) throw fail(404, "not_found");
      if (!isObj(body) || typeof body.principalId !== "string" || !body.principalId || body.principalId.length > 200)
        throw fail(400, "bad_request");
      if (actor && actor.p !== body.principalId) throw fail(403, "forbidden");
      let seeds;
      try {
        seeds = parseSuggestedActivities(JSON.stringify(body.seeds ?? []));
      } catch {
        return reply(400, { error: "bad_request" });
      }
      const timezone = body.timezone ?? "UTC";
      if (typeof timezone !== "string" || timezone.length > 100) throw fail(400, "bad_request");
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone });
      } catch {
        return reply(400, { error: "bad_request" });
      }
      return ok(
        await deps.suggestedActivities.get(body.principalId, seeds, {
          timezone,
          poll: body.poll === true,
          refresh: body.refresh === true,
        }),
      );
    },
  },
  {
    method: "POST",
    path: "/v1/suggested-activities/dismiss",
    auth: "source",
    handle: async ({ deps, body, actor }) => {
      if (!deps.suggestedActivities) throw fail(404, "not_found");
      if (
        !isObj(body) ||
        typeof body.principalId !== "string" ||
        !body.principalId ||
        body.principalId.length > 200 ||
        typeof body.id !== "string" ||
        body.id.length > 64
      )
        throw fail(400, "bad_request");
      if (actor && actor.p !== body.principalId) throw fail(403, "forbidden");
      if (!(await deps.suggestedActivities.dismiss(body.principalId, body.id))) throw fail(404, "not_found");
      return ok({ dismissed: true });
    },
  },
];
