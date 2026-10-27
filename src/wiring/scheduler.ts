import type { Head } from "./late.ts";
import { type SuggestedActivityProfile, createSuggestedActivityService } from "../suggestions/activities.ts";
import { createMemoryTidyService, type MemoryTidyProfile } from "../memory/tidy.ts";
import { createJobWorker } from "../jobs/job-worker.ts";
import { createScheduler } from "../cron/scheduler.ts";
import { createControlService } from "../api/control-service.ts";
import { availableRuntimeError } from "../api/runtime-config.ts";
import { providerKeysPresent } from "../config.ts";
import { createRuntimeService } from "../harness/runtime-control.ts";
import type { StoresModule } from "./stores.ts";
import type { MemoryModule } from "./memory.ts";
import type { CronsModule } from "./crons.ts";
import type { ApiAppModule } from "./api-app.ts";
import type { TriggersModule } from "./triggers.ts";
import type { OrchestratorModule } from "./orchestrator.ts";
import type { HarnessModule } from "./harness.ts";
import type { ModelCredentialsModule } from "./model-credentials.ts";
import type { ModelKeysModule } from "./model-keys.ts";

export function buildScheduler(
  w: Head &
    StoresModule &
    MemoryModule &
    CronsModule &
    ApiAppModule &
    TriggersModule &
    OrchestratorModule &
    HarnessModule &
    ModelCredentialsModule &
    ModelKeysModule,
) {
  const {
    artifactMap,
    baseMemory,
    crons,
    late,
    databaseUrl,
    admittedWork,
    app,
    advisoryLock,
    triggerDeps,
    config,
    sessions,
    orchestratorDeps,
    admin,
    configStore,
    fallback,
    modelCredentials,
    overrides,
    refreshModels,
  } = w;

  const suggestedActivityProfiles = artifactMap<SuggestedActivityProfile>("suggested_activity_profiles");
  const memoryTidy = createMemoryTidyService({
    store: artifactMap<MemoryTidyProfile>("memory_tidy_profiles"),
    memory: baseMemory,
    timezone: async (principalId) => (await suggestedActivityProfiles.get(principalId))?.timezone,
    crons,
    scheduler: { notifyChanged: (id) => scheduler.notifyChanged(id) },
  });
  late.memoryTidy = memoryTidy;
  const jobs = createJobWorker(databaseUrl);
  const scheduler = createScheduler({
    admittedWork,
    skipFire: async (cron) => (await memoryTidy.skipFire(cron)) ?? suggestedActivities.skipFire(cron),
    deleteCron: (id) => app.deleteCron(id),
    advisoryLock,
    crons,
    ...triggerDeps,
    jobs,
    fireConcurrency: config.cronFireConcurrency,
  });
  late.scheduler = scheduler;
  const suggestedActivities = createSuggestedActivityService({
    store: suggestedActivityProfiles,
    sessions,
    crons,
    scheduler,
    enabled: config.suggestedActivitiesEnabled === true,
    ...(config.suggestedActivitiesContext ? { context: config.suggestedActivitiesContext } : {}),
  });
  orchestratorDeps.control = createControlService(app, scheduler, admin);
  orchestratorDeps.validateScheduledRuntime = (scope, choice, purpose) =>
    availableRuntimeError(
      {
        deps: {
          config: configStore,
          baseModelDefault: fallback.modelId,
          providerKeys: providerKeysPresent(config),
          modelCredentials,
          modelCredentialFetch: overrides.modelCredentialFetch,
          refreshModels,
        },
      },
      scope,
      choice,
      purpose,
    );
  orchestratorDeps.runtime = createRuntimeService(
    {
      config: configStore,
      get baseModelDefault() {
        return fallback.modelId;
      },
      providerKeys: providerKeysPresent(config),
      modelCredentials,
      modelCredentialFetch: overrides.modelCredentialFetch,
      refreshModels,
    },
    app,
  );
  return { jobs, scheduler, suggestedActivities };
}

export type SchedulerModule = ReturnType<typeof buildScheduler>;
