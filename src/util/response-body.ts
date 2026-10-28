import { swallowAs } from "../../plugins/chassis/src/errors.ts";

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

export async function readTextPrefix(response: Response, maxChars: number, signal?: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const stop = () => void reader.cancel(signal?.reason).catch(swallowAs("response prefix: cancel body", undefined));
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      text += decoder.decode(value, { stream: true });
      if (text.length >= maxChars) {
        stop();
        return text.slice(0, maxChars);
      }
    }
  } finally {
    signal?.removeEventListener("abort", stop);
    reader.releaseLock();
  }
}
