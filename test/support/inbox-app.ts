import { createCronStore } from "../../src/cron/cron-store.ts";
import { testDatabaseUrl } from "./test-database.ts";

export function inboxApp() {
  const crons = createCronStore(testDatabaseUrl());
  return {
    crons,
    app: {
      listCrons: () => crons.list(),
      createCron: (input: Parameters<typeof crons.create>[0]) => crons.create(input),
      getCron: (id: string) => crons.get(id),
      updateCron: (id: string, patch: Parameters<typeof crons.update>[1]) => crons.update(id, patch),
      setCronEnabled: (id: string, enabled: boolean) => crons.setEnabled(id, enabled),
      samePerson: async (a: string, b: string) => a === b,
      membershipControlsScope: async () => false,
      managesScope: async () => false,
      isCurrentSharedScopeMember: async () => false,
      artifactGrantPermission: async () => null,
    },
  };
}
