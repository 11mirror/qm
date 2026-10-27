import { createPgPool } from "../persistence/pg-pool.ts";
import { lockedRow } from "../persistence/locked-row.ts";
import { mapToTableMigration, tableCodec, type TableSpec } from "../persistence/typed-table.ts";
import { sleep, createKeyedQueue } from "../util/async.ts";
import { holdUntilDone, type LeaderLease } from "../persistence/leader-lease.ts";
import { swallowAs } from "../util/errors.ts";
import { isTerminal, type RunStore } from "../runs/run-store.ts";
import { runResultPost } from "../runs/run-results.ts";
import { slackErrorCode } from "./payloads.ts";

export interface TaskAckState {
  channel: string;
  emoji: string;
  target: string;
  previous: string[];
  finished: boolean;
  synced?: boolean;
}

interface ReactionClient {
  reactions: {
    add(input: { channel: string; timestamp: string; name: string }): Promise<unknown>;
    remove(input: { channel: string; timestamp: string; name: string }): Promise<unknown>;
  };
}

type Next = { channel: string; ts: string; pick?: () => Promise<string | undefined>; existing?: boolean };
const retire = (state: TaskAckState): string[] => [...new Set([...state.previous, state.target])].filter(Boolean);

const TASK_ACKS: TableSpec = {
  table: "slack_task_acknowledgements",
  key: "id",
  columns: {
    channel: { type: "text", required: true },
    emoji: { type: "text", required: true },
    target: { type: "text", required: true },
    previous: { type: "text[]", required: true },
    finished: { type: "boolean", required: true },
    synced: { type: "boolean" },
  },
};

export const TASK_ACKS_MIGRATION = mapToTableMigration("slack/task-acks/0001-typed", TASK_ACKS);

const codec = tableCodec<TaskAckState>(TASK_ACKS);

export function createTaskAckStore(databaseUrl: string) {
  const pg = createPgPool(databaseUrl, [TASK_ACKS_MIGRATION]);
  const { q } = pg;
  const modify = lockedRow<TaskAckState>(pg, TASK_ACKS);
  return {
    async get(runId: string): Promise<TaskAckState | null> {
      return (
        codec.rows(await q(`SELECT ${codec.columns} FROM slack_task_acknowledgements WHERE id = $1`, [runId]))[0] ??
        null
      );
    },
    async insert(runId: string, state: TaskAckState): Promise<void> {
      await q(
        `INSERT INTO slack_task_acknowledgements (${codec.columns}) VALUES (${codec.placeholders}) ON CONFLICT DO NOTHING`,
        codec.values(runId, state),
      );
    },
    update: (runId: string, fn: (current: TaskAckState) => TaskAckState) =>
      modify(runId, (current) => current && fn(current)),
    async unsettled(): Promise<Array<[string, TaskAckState]>> {
      const rows = await q(
        `SELECT ${codec.columns} FROM slack_task_acknowledgements WHERE NOT finished OR synced IS NOT TRUE ORDER BY id`,
      );
      return rows.map((r) => [String(r.id), codec.row(r)]);
    },
  };
}

export type TaskAckStore = ReturnType<typeof createTaskAckStore>;

export function createTaskAcknowledgements(
  store: TaskAckStore,
  lease: LeaderLease,
  recovery?: { runs: Pick<RunStore, "get"> },
) {
  const update = store.update;
  const queue = createKeyedQueue<string>();
  const change = (client: ReactionClient, runId: string, next?: Next) => queue(runId, () => apply(client, runId, next));
  const apply = (client: ReactionClient, runId: string, next?: Next) =>
    holdUntilDone(lease, `slack:task-ack:${runId}`, "Task acknowledgement lock timed out", async (lost) => {
      let state = await store.get(runId);
      if (!state) {
        if (next?.existing) return true;
        const emoji = next?.pick
          ? await Promise.race([
              next.pick().catch(swallowAs("slack: pick task ack emoji", undefined)),
              sleep(1500).then(() => undefined),
            ])
          : undefined;
        if (lost()) return false;
        await store.insert(runId, {
          channel: next?.channel ?? "",
          emoji: emoji || "eyes",
          target: next?.ts ?? "",
          previous: [],
          finished: !next,
        });
      }
      if (lost()) return false;
      state = await update(runId, (current) => {
        if (current.finished) return current;
        if (!next) return { ...current, finished: true, synced: false, previous: retire(current) };
        if (current.channel === next.channel && Number(next.ts) > Number(current.target))
          return { ...current, target: next.ts, synced: false, previous: retire(current) };
        return current;
      });
      if (!state || lost()) return false;
      const snapshot = state;
      const reaction = async (action: "add" | "remove", ts: string) => {
        try {
          await client.reactions[action]({ channel: snapshot.channel, timestamp: ts, name: snapshot.emoji });
        } catch (error) {
          const code = slackErrorCode(error);
          if (!(action === "add" ? code === "already_reacted" : code === "no_reaction" || code === "message_not_found"))
            throw error;
        }
      };
      if (!state.finished) {
        await reaction("add", state.target);
        const current = await store.get(runId);
        if (current?.finished || current?.target !== state.target) {
          await update(runId, (value) => ({
            ...value,
            previous: [...new Set([...value.previous, snapshot.target])],
            synced: false,
          }));
          await reaction("remove", state.target);
        }
      }
      if (lost()) return false;
      for (const ts of state.previous) {
        if (lost()) return false;
        await reaction("remove", ts);
        await update(runId, (current) => ({ ...current, previous: current.previous.filter((old) => old !== ts) }));
      }
      await update(runId, (current) =>
        current.target === snapshot.target && current.finished === snapshot.finished && current.previous.length === 0
          ? { ...current, synced: true }
          : current,
      );
      return true;
    });
  return {
    reconcile: async (client: ReactionClient) => {
      for (const [runId, state] of await store.unsettled()) {
        if (!state.finished && recovery) {
          const run = await recovery.runs.get(runId);
          if (run && isTerminal(run.status) && (run.deliveryState?.postedAt !== undefined || !runResultPost(run))) {
            await change(client, runId).catch(swallowAs("slack: finish recovered task acknowledgement", undefined));
            continue;
          }
        }
        if (!state.synced)
          await change(client, runId, { channel: state.channel, ts: state.target, existing: true }).catch(
            swallowAs("slack: reconcile task acknowledgement", undefined),
          );
      }
    },
    move: (
      client: ReactionClient,
      runId: string,
      channel: string,
      ts: string,
      pick?: () => Promise<string | undefined>,
    ) => change(client, runId, { channel, ts, pick }),
    finish: (client: ReactionClient, runId: string) => change(client, runId),
  };
}

export type TaskAcknowledgements = ReturnType<typeof createTaskAcknowledgements>;
