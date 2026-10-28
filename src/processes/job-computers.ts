import type { ProcessSandbox, SandboxHandle } from "../sandbox/sandbox.ts";
import type { SandboxResources } from "../sandbox/sandbox-resources.ts";
import type { ProcessRecord, ProcessRegistry } from "./process-registry.ts";
import { reconcileProcesses } from "./reconcile.ts";

const STARTUP_GRACE_MS = 2 * 60_000;
const PROVISION_LIMIT_MS = 15 * 60_000;
const RETRY_EVERY_MS = 5 * 60_000;

const live = (job: ProcessRecord): boolean => job.status === "running" || Boolean(job.credentialsPending);

export function createJobComputerSweep(deps: {
  resources: Pick<SandboxResources, "jobComputers" | "retireJobComputer">;
  sandbox: ProcessSandbox;
  processes: ProcessRegistry;
  finish: (handle: SandboxHandle, processId: string) => Promise<void>;
  onError: (error: unknown, scopeId: string) => void;
  now?: () => number;
}): () => Promise<void> {
  const attemptedAt = new Map<string, number>();
  const idleSince = new Map<string, number>();
  const clock = deps.now ?? Date.now;
  return async () => {
    const now = clock();
    for (const computer of await deps.resources.jobComputers()) {
      try {
        const retire = async (why: string) => {
          await deps.resources.retireJobComputer(computer.id, computer.state);
          console.log(`[job-computers] retired ${computer.id} in ${computer.ownerScopeId}: ${why}`);
          attemptedAt.delete(computer.id);
          idleSince.delete(computer.id);
        };
        const throttled = now - (attemptedAt.get(computer.id) ?? 0) < RETRY_EVERY_MS;
        if (computer.state === "provisioning") {
          if (now - Date.parse(computer.createdAt) < PROVISION_LIMIT_MS || throttled) continue;
          attemptedAt.set(computer.id, now);
          await retire("stuck provisioning");
          continue;
        }
        if (computer.state === "retired" || computer.error) {
          if (throttled) continue;
          attemptedAt.set(computer.id, now);
          await retire(computer.error ? "errored" : "already retired");
          continue;
        }
        const jobs = () => deps.processes.listBySandbox(computer.ownerScopeId, computer.id);
        let current = await jobs();
        if (!current.some(live)) idleSince.set(computer.id, idleSince.get(computer.id) ?? now);
        if (!current.length && now - idleSince.get(computer.id)! < STARTUP_GRACE_MS) continue;
        if (current.some(live)) {
          idleSince.delete(computer.id);
          if (throttled) continue;
          attemptedAt.set(computer.id, now);
          const handle = await deps.sandbox.provision([{ scopeId: computer.ownerScopeId, mode: "rw", mountPath: "" }], {
            sandboxId: computer.id,
          });
          try {
            await reconcileProcesses(deps.sandbox, handle, deps.processes, computer.ownerScopeId, deps.finish);
          } finally {
            await deps.sandbox
              .teardown(handle, { keepWarm: true })
              .catch((error: unknown) => deps.onError(error, computer.ownerScopeId));
          }
          current = await jobs();
          if (current.some(live)) continue;
        }
        attemptedAt.set(computer.id, now);
        await retire(
          `${Math.round((now - (idleSince.get(computer.id) ?? now)) / 1000)}s after its jobs were seen to exit`,
        );
      } catch (error) {
        deps.onError(error, computer.ownerScopeId);
      }
    }
  };
}
