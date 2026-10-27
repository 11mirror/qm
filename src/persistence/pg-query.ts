import type { Pool, PoolClient } from "pg";
import { swallow, swallowAs } from "../util/errors.ts";
import type { PgQueryOptions, Rows } from "./pg-pool.ts";

export async function rollbackOrReport(client: PoolClient, context: string): Promise<Error | undefined> {
  try {
    await client.query("ROLLBACK");
    return undefined;
  } catch (error) {
    swallow(context, error);
    return error instanceof Error ? error : new Error(String(error));
  }
}

async function withStatementTimeout<T>(
  client: PoolClient,
  timeoutMs: number | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (timeoutMs === undefined) return run();
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("Query timeout must be a positive finite number");
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL statement_timeout = ${Math.round(timeoutMs)}`);
    const result = await run();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(swallowAs("pg-pool: rollback query timeout", undefined));
    throw error;
  }
}

export async function runPgQuery(
  p: Pool,
  text: string,
  params: unknown[],
  options: PgQueryOptions,
): Promise<{ rows: Rows; rowCount: number }> {
  if (!options.signal && options.timeoutMs === undefined) {
    const res = await p.query(text, params);
    return { rows: res.rows as Rows, rowCount: res.rowCount ?? 0 };
  }
  if (!options.signal) {
    const client = await p.connect();
    let queryError: Error | undefined;
    try {
      return await withStatementTimeout(client, options.timeoutMs, async () => {
        const res = await client.query({ text, values: params });
        return { rows: res.rows as Rows, rowCount: res.rowCount ?? 0 };
      });
    } catch (error) {
      queryError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      client.release(queryError);
    }
  }
  if (options.signal.aborted) throw new DOMException("Postgres query cancelled", "AbortError");
  const connectPromise = p.connect();
  let connectAbort: (() => void) | undefined;
  const connectAbortPromise = new Promise<never>((_, reject) => {
    connectAbort = () => reject(new DOMException("Postgres query cancelled", "AbortError"));
    options.signal!.addEventListener("abort", connectAbort, { once: true });
  });
  let client: PoolClient;
  try {
    client = await Promise.race([connectPromise, connectAbortPromise]);
  } catch (error) {
    void connectPromise
      .then(
        (lateClient) => lateClient.release(error instanceof Error ? error : new Error(String(error))),
        () => undefined,
      )
      .catch(() => undefined);
    throw error;
  } finally {
    if (connectAbort) options.signal.removeEventListener("abort", connectAbort);
  }
  let queryError: Error | undefined;
  let released = false;
  const cancel = () => {
    if (released) return;
    released = true;
    client.release(new Error("Postgres query cancelled"));
  };
  options.signal.addEventListener("abort", cancel, { once: true });
  try {
    if (released) throw new Error("Postgres query cancelled");
    return await withStatementTimeout(client, options.timeoutMs, async () => {
      const res = await client.query({ text, values: params });
      return { rows: res.rows as Rows, rowCount: res.rowCount ?? 0 };
    });
  } catch (error) {
    queryError = error instanceof Error ? error : new Error(String(error));
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    if (!released) client.release(queryError);
  }
}
