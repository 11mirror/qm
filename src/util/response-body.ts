import { swallowAs } from "./errors.ts";

/**
 * A response body as UTF-8 text, refusing bodies over `maxBytes` by declared length or by bytes
 * read. Returns undefined when the response has no body.
 */
export async function readCappedText(
  response: Response,
  maxBytes: number,
  tooLarge: () => Error,
): Promise<string | undefined> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(swallowAs("capped response: cancel body", undefined));
    throw tooLarge();
  }
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(swallowAs("capped response: cancel body", undefined));
        throw tooLarge();
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}
