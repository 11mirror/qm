import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createJobExitSweep, renderJobExit, type JobEnding } from "../../src/processes/job-exit-mail.ts";
import { createPostgresProcessRegistry, type ProcessRecord } from "../../src/processes/process-registry.ts";
import type { ProcessSandbox, ProcessSession, ProcessState, SandboxHandle } from "../../src/sandbox/sandbox.ts";
import type { Monitor } from "../../src/types.ts";
import { testDatabaseUrl } from "../support/test-database.ts";

const handle: SandboxHandle = { id: "vm", rootDir: "/workspace", homeDir: "/root" };

function fakeComputer() {
  const jobs = new Map<string, { output: string; status: ProcessState }>();
  let teardowns = 0;
  const unsupported = async () => {
    throw new Error("unused");
  };
  const sandbox: ProcessSandbox = {
    profile: { backend: "fake", writablePersistence: "resident_disk", processSessions: true },
    provision: async () => handle,
    run: unsupported,
    readFile: unsupported,
    writeFile: unsupported,
    writeFileBytes: unsupported,
    readFileBytes: unsupported,
    listDir: unsupported,
    removeDir: unsupported,
    startProcess: unsupported,
    async readProcess(_h, id, opts) {
      const job = jobs.get(id)!;
      const cur = opts?.sinceCursor ?? 0;
      const end = Math.min(job.output.length, cur + (opts?.maxBytes ?? 65_536));
      return { chunks: job.output.slice(cur, end), cursor: end, status: job.status };
    },
    writeStdin: unsupported,
    signalProcess: unsupported,
    async listProcesses(): Promise<ProcessSession[]> {
      return [...jobs].map(([processId, job]) => ({ processId, command: "", startedAt: 0, status: job.status }));
    },
    async teardown() {
      teardowns++;
    },
  };
  return { sandbox, jobs, teardowns: () => teardowns };
}

test("the exit sweep wakes the session of each finished job once and leaves running and watched jobs alone", async () => {
  const processes = createPostgresProcessRegistry(testDatabaseUrl());
  const computer = fakeComputer();
  const sandboxId = `sandbox-${randomUUID()}`;
  const [done, running, watched, lost, detached] = [1, 2, 3, 4, 5].map(() => randomUUID()) as [
    string,
    string,
    string,
    string,
    string,
  ];
  for (const processId of [done, running, watched, lost, detached])
    await processes.register({
      processId,
      scopeId: "personal:U1",
      sandboxId,
      kind: "background",
      command: "bg: npm test",
      purpose: "run the suite",
      ttlMs: 60_000,
      ...(processId === detached ? {} : { sessionRef: "agent:main:subagent:abc" }),
    });
  computer.jobs.set(done, { output: `${"x".repeat(5_000)}\n3 passing\n`, status: { state: "exited", code: 0 } });
  computer.jobs.set(running, { output: "", status: { state: "running" } });
  computer.jobs.set(watched, { output: "", status: { state: "exited", code: 2 } });
  computer.jobs.set(detached, { output: "", status: { state: "exited", code: 0 } });
  const woken: Array<{ rec: ProcessRecord; ending: JobEnding }> = [];
  const exits: string[] = [];
  const sweep = createJobExitSweep({
    processes,
    monitors: { enabled: async () => [{ processId: watched } as Monitor] },
    sandbox: computer.sandbox,
    notify: async (rec, ending) => {
      woken.push({ rec, ending });
    },
    onExit: async (_h, processId) => {
      exits.push(processId);
    },
  });
  await sweep.tick();
  await sweep.tick();
  assert.deepEqual(woken.map((w) => w.rec.processId).sort(), [done, lost].sort());
  const finished = woken.find((w) => w.rec.processId === done)!.ending;
  assert.equal(finished.kind, "exited");
  assert.ok(finished.kind === "exited" && finished.code === 0 && finished.tail.endsWith("3 passing\n"));
  assert.ok(finished.kind === "exited" && finished.tail.length === 4_096);
  assert.equal(woken.find((w) => w.rec.processId === lost)!.ending.kind, "lost");
  assert.deepEqual(exits, [done]);
  assert.equal((await processes.get(done))?.status, "exited");
  assert.equal((await processes.get(running))?.status, "running");
  assert.equal((await processes.get(watched))?.status, "running");
  assert.equal(computer.teardowns(), 2);
});

test("a failed wake leaves the job running so the next sweep retries it", async () => {
  const processes = createPostgresProcessRegistry(testDatabaseUrl());
  const computer = fakeComputer();
  const processId = randomUUID();
  await processes.register({
    processId,
    scopeId: "personal:U1",
    sandboxId: `sandbox-${processId}`,
    kind: "background",
    command: "bg: npm test",
    ttlMs: 60_000,
    sessionRef: "web:session:1",
  });
  computer.jobs.set(processId, { output: "ok\n", status: { state: "exited", code: 0 } });
  let attempts = 0;
  const sweep = createJobExitSweep({
    processes,
    monitors: { enabled: async () => [] },
    sandbox: computer.sandbox,
    notify: async () => {
      attempts++;
      if (attempts === 1) throw new Error("database blip");
    },
  });
  await sweep.tick();
  assert.equal((await processes.get(processId))?.status, "running");
  await sweep.tick();
  assert.equal(attempts, 2);
  assert.equal((await processes.get(processId))?.status, "exited");
});

test("the exit notice names the job, its ending and the end of its output as data", () => {
  const rec = {
    processId: "p-1",
    scopeId: "personal:U1",
    kind: "background",
    command: "bg: npm test",
    purpose: "run the suite",
    startedAt: 0,
    expiresAt: 0,
    status: "running",
  } as const;
  const exited = renderJobExit(rec, { kind: "exited", code: 1, tail: "<b>2 failed</b>" });
  assert.match(exited, /^<background-job processId="p-1" ending="exited">/);
  assert.match(exited, /“run the suite”\) that you started exited with code 1\./);
  assert.match(exited, /&lt;b&gt;2 failed&lt;\/b&gt;/);
  assert.doesNotMatch(renderJobExit(rec, { kind: "expired" }), /output-tail/);
  assert.match(renderJobExit(rec, { kind: "lost" }), /no longer on its computer/);
});
