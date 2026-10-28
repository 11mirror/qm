import { errChain as errMessage } from "../../plugins/chassis/src/errors.ts";
import { readTextPrefix } from "./response-body.ts";

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
  const body = await readTextPrefix(res, bodyChars, signal).catch(() => "");
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

const FAILURE_OUTPUT_CHARS = 300;

export function execFailure(what: string, r: { stdout: string; stderr: string; code: number }): Error {
  const tail = (out: string): string => out.trim().slice(-FAILURE_OUTPUT_CHARS);
  const parts = [`${what} failed (exit ${r.code}${r.code === 124 ? ", timed out" : ""})`];
  if (r.stderr.trim()) parts.push(`stderr: ${tail(r.stderr)}`);
  if (r.stdout.trim()) parts.push(`stdout: ${tail(r.stdout)}`);
  return new Error(parts.join("; "));
}
