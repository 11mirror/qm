import assert from "node:assert/strict";

export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, Array<(event: { data: string }) => void>>();
  closed = false;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, listener: (event: { data: string }) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  response(signal?: AbortSignal | null) {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
    signal?.addEventListener("abort", () => this.close(), { once: true });
    this.controller!.enqueue(
      new TextEncoder().encode(`data: ${JSON.stringify({ type: "RUN_STARTED", threadId: "r1", runId: "r1" })}\n\n`),
    );
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }
  emit(name: string, data: unknown) {
    if (this.controller && !this.closed) {
      const event = { type: "CUSTOM", name: "run", value: data };
      this.controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    }
    for (const listener of this.listeners.get(name) ?? []) listener({ data: JSON.stringify(data) });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.controller?.close();
  }
}

export const settle = () => new Promise((resolve) => setTimeout(resolve, 160));

export async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not settle");
}
