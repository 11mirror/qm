import type { JobHandler, JobWorker } from "../../src/jobs/job-worker.ts";

export function inlineJobs(): Pick<JobWorker, "handle" | "spawn"> {
  const handlers = new Map<string, JobHandler>();
  const spawned = new Set<string>();
  return {
    handle(name, run) {
      handlers.set(name, run);
    },
    async spawn(name, params, key) {
      if (spawned.has(key)) return;
      spawned.add(key);
      const run = handlers.get(name);
      if (!run) throw new Error(`inlineJobs: no handler for ${name}`);
      setImmediate(() => void run(structuredClone(params)));
    },
  };
}
