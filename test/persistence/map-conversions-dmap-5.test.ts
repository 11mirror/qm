import { test } from "node:test";
import { AWS_DEPLOY_BODIES_MIGRATION } from "../../src/deploy/aws-deploy-provider.ts";
import { DEPLOY_GIT_REPOS_MIGRATION } from "../../src/deploy/deploy-git-store.ts";
import { DEPLOYMENTS_MIGRATION } from "../../src/deploy/deploy-store.ts";
import { E2B_DEPLOY_BODIES_MIGRATION } from "../../src/deploy/e2b-deploy-provider.ts";
import { PORTER_DEPLOY_BODIES_MIGRATION } from "../../src/deploy/porter-deploy-provider.ts";
import { DEPLOYMENT_LAYER_MIGRATION } from "../../src/deployment/deployment-layer-store.ts";
import { PROJECTS_MIGRATION } from "../../src/projects/project-store.ts";
import { assertMapConversion } from "../support/map-conversion.ts";

const CONVERSIONS = [
  DEPLOYMENTS_MIGRATION,
  DEPLOY_GIT_REPOS_MIGRATION,
  AWS_DEPLOY_BODIES_MIGRATION,
  PORTER_DEPLOY_BODIES_MIGRATION,
  E2B_DEPLOY_BODIES_MIGRATION,
  DEPLOYMENT_LAYER_MIGRATION,
  PROJECTS_MIGRATION,
];

for (const conversion of CONVERSIONS)
  test(`${conversion.spec.table} converts in place for one tenant and for two`, () => assertMapConversion(conversion));
