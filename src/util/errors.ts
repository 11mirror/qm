import { errChain as errMessage } from "../../plugins/chassis/src/errors.ts";
import { readTextPrefix } from "./response-body.ts";
import { tailSlice } from "./text.ts";

export {
  errorAlreadyReported,
  markErrorReported,
  reportFailure,
  reportFailureAs,
} from "../../plugins/chassis/src/error-reporting.ts";
export { asError, errChain as errMessage, failureCode, swallow, swallowAs } from "../../plugins/chassis/src/errors.ts";

const REQUEST_ID_HEADERS = ["x-request-id", "x-amzn-requestid", "fly-request-id"];

export function withRequestId(message: string, headers: Headers): string {
  for (const name of REQUEST_ID_HEADERS) {
    const value = headers.get(name);
    if (value) return `${message} [request id ${value}]`;
  }
  return message;
}

export async function httpFailure(res: Response, bodyChars = 200, signal?: AbortSignal): Promise<string> {
  const body = await readTextPrefix(res, bodyChars, signal).catch(
    (e: unknown) => `(body unreadable: ${errMessage(e)})`,
  );
  return withRequestId(`http ${res.status} ${body}`, res.headers);
}

export async function withCleanup<T>(work: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  let result: T;
  try {
    result = await work();
  } catch (error) {
    await cleanup().catch((cleanupError: unknown) => {
      throw new AggregateError([error, cleanupError], errMessage(error), { cause: error });
    });
    throw error;
  }
  await cleanup();
  return result;
}

export async function cleanupAll(actions: Array<() => void | Promise<unknown>>, original?: unknown): Promise<void> {
  const failures: unknown[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    const cause = original ?? failures[0];
    throw new AggregateError(original === undefined ? failures : [original, ...failures], errMessage(cause), { cause });
  }
}

const FAILURE_OUTPUT_CHARS = 300;

export function execFailure(what: string, r: { stdout: string; stderr: string; code: number }): Error {
  const tail = (out: string): string => {
    const trimmed = out.trim();
    return trimmed.length > FAILURE_OUTPUT_CHARS ? `…${tailSlice(trimmed, FAILURE_OUTPUT_CHARS)}` : trimmed;
  };
  const parts = [`${what} failed (exit ${r.code}${r.code === 124 ? ", timed out" : ""})`];
  if (r.stderr.trim()) parts.push(`stderr: ${tail(r.stderr)}`);
  if (r.stdout.trim()) parts.push(`stdout: ${tail(r.stdout)}`);
  return new Error(parts.join("; "));
}
