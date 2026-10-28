import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createJobExits, renderJobExit } from "../../src/processes/job-exit-mail.ts";
import { createPostgresProcessRegistry, type ProcessRegistry } from "../../src/processes/process-registry.ts";
import type { Run } from "../../src/runs/run-store.ts";
import type { SessionMessage } from "../../src/sessions/session-mailbox.ts";
import type { ProcessSandbox, ProcessSession, ProcessState, SandboxHandle } from "../../src/sandbox/sandbox.ts";
import type { Monitor, Session } from "../../src/types.ts";
import { testDatabaseUrl } from "../support/test-database.ts";
import { actor, conversation } from "../support/subagent-rig.ts";

const handle: SandboxHandle = { id: "vm", rootDir: "/workspace", homeDir: "/root" };

function fakeComputer() {
  const jobs = new Map<string, { output: string; status: ProcessState }>();
  let teardowns = 0;
  const unsupported = async () => {
    throw new Error("unused");
  };
  const sandbox: ProcessSandbox = {
    profile: { backend: "fake", writablePersistence: "resident_disk", processSessions: true },
    provision: async (_mounts, opts) => ({ ...handle, ...(opts?.sandboxId ? { resourceId: opts.sandboxId } : {}) }),
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

function exits(computer: ReturnType<typeof fakeComputer>, watched: string[] = []) {
  const processes = createPostgresProcessRegistry(testDatabaseUrl());
  const mailed: SessionMessage[] = [];
  const finished: string[] = [];
  const base = { id: "run-1", sessionId: "", request: { actor, conversation, origin: { kind: "human" } } } as unknown as Run;
  const jobExits = createJobExits({
    processes,
    monitors: { enabled: async () => watched.map((processId) => ({ processId }) as Monitor) },
    sandbox: computer.sandbox,
    sessions: { getByThread: async (threadRef) => ({ id: `session:${threadRef}` }) as Session },
    runs: { get: async () => null, latestForThread: async (threadRef) => ({ ...base, sessionId: threadRef }) },
    mailbox: {
      send: async (message) => {
        mailed.push(message);
      },
    },
    finish: async (_handle, processId) => {
      finished.push(processId);
    },
  });
  return { processes, mailed, finished, jobExits };
}

const register = (processes: ProcessRegistry, processId: string, sandboxId: string, sessionRef?: string) =>
  processes.register({
    processId,
    scopeId: "personal:U1",
    sandboxId,
    kind: "background",
    command: "bg: npm test",
    purpose: "run the suite",
    ttlMs: 60_000,
    ...(sessionRef ? { sessionRef } : {}),
  });

test("the exit sweep mails the owning session of each ended job once and leaves running and watched jobs alone", async () => {
  const computer = fakeComputer();
  const [done, running, watched, lost] = [1, 2, 3, 4].map(() => randomUUID()) as [string, string, string, string];
  const { processes, mailed, finished, jobExits } = exits(computer, [watched]);
  const sandboxId = `sandbox-${randomUUID()}`;
  for (const processId of [done, running, watched, lost])
    await register(processes, processId, sandboxId, "agent:main:subagent:abc");
  computer.jobs.set(done, { output: `${"x".repeat(5_000)}\n3 passing\n`, status: { state: "exited", code: 0 } });
  computer.jobs.set(running, { output: "", status: { state: "running" } });
  computer.jobs.set(watched, { output: "", status: { state: "exited", code: 2 } });
  await jobExits.sweep();
  await jobExits.sweep();
  assert.deepEqual(mailed.map((message) => message.id).sort(), [`job-exit-${done}`, `job-exit-${lost}`].sort());
  const doneMail = mailed.find((message) => message.id === `job-exit-${done}`)!;
  assert.equal(doneMail.recipientId, "session:agent:main:subagent:abc");
  assert.match(doneMail.text, /exited with code 0/);
  assert.match(doneMail.text, /3 passing/);
  assert.match(mailed.find((message) => message.id === `job-exit-${lost}`)!.text, /no longer on its computer/);
  assert.equal((await processes.get(done))?.status, "exited");
  assert.equal((await processes.get(watched))?.status, "exited");
  assert.equal((await processes.get(running))?.status, "running");
  assert.equal(computer.teardowns(), 1);
  assert.ok(finished.includes(done));
});

test("an expired job notifies unless it is watched", async () => {
  const computer = fakeComputer();
  const { processes, mailed, jobExits } = exits(computer, ["watched"]);
  const rec = await register(processes, randomUUID(), "sandbox-x", "web:session:1");
  await jobExits.expired(rec);
  await jobExits.expired({ ...rec, processId: "watched" });
  assert.deepEqual(
    mailed.map((message) => message.id),
    [`job-exit-${rec.processId}`],
  );
  assert.match(mailed[0]!.text, /reached its time limit/);
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
