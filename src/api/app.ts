import { WorkAdmissionClosed } from "../util/admitted-work.ts";
import { createResourceSearchMethods } from "./app-resource-search.ts";
import type { App, AppDeps } from "./app-types.ts";
import { createAppHelpers } from "./app-helpers.ts";
import { createAmbientHelpers } from "./app-ambient.ts";
import { createTurnMethods } from "./app-turn.ts";
import { createSessionMethods } from "./app-sessions.ts";
import { createMessagingMethods } from "./app-messaging.ts";
import { createDeploymentMethods } from "./app-deployments.ts";
import { createSkillMethods } from "./app-skills.ts";
import { createSearchMethods } from "./app-search.ts";

export type { App, AppDeps, ContextSummary, ProjectView, VisibleCron } from "./app-types.ts";
export { deploymentView } from "./app-types.ts";
export type { DeployInput, RedeployInput } from "../deploy/deploy-service.ts";

export function createApp(deps: AppDeps): App {
  const app = {} as App;
  const helpers = createAppHelpers(deps, app);
  const ambient = createAmbientHelpers(deps, app);
  const { turn, ...methods } = {
    ...createTurnMethods(deps, helpers, ambient),
    ...createSessionMethods(deps, helpers),
    ...createMessagingMethods(deps, helpers, ambient),
    ...createDeploymentMethods(deps, helpers),
    ...createSkillMethods(deps, helpers),
    ...createSearchMethods(deps, app, helpers),
    ...createResourceSearchMethods(deps, app, helpers),
  };
  return Object.assign(app, {
    ...methods,
    async turn(req, replay) {
      if (!deps.admittedWork || req.async) return turn(req, replay);
      try {
        return await deps.admittedWork.run(() => turn(req, replay));
      } catch (error) {
        if (error instanceof WorkAdmissionClosed) return { status: "refused", reason: error.message };
        throw error;
      }
    },
  } satisfies App);
}
