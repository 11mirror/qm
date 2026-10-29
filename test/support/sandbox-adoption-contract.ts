import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { TestContext } from "node:test";
import type { WorkspaceLayer } from "../../src/types.ts";
import type { SandboxShared } from "../../src/sandbox/provider-sandbox.ts";
import type { Sandbox } from "../../src/sandbox/sandbox.ts";

export async function sandboxAdoptionContract(
  make: (options?: Partial<SandboxShared>) => Sandbox,
  layers: WorkspaceLayer[],
): Promise<void> {
  const previous = make();
  const first = await previous.provision(layers, {
    env: {
      AGENT_API_URL: "https://old.example",
      AGENT_API_TOKEN: "old",
      MODEL_GATEWAY_URL: "https://old-gateway.example",
    },
  });
  await previous.writeFile(first, "carry-over.txt", "bytes");
  await previous.teardown(first);
  const freshEnv = {
    AGENT_API_URL: "https://new.example",
    AGENT_API_TOKEN: "fresh",
    MODEL_GATEWAY_URL: "https://new-gateway.example",
  };
  const adopted = make({
    tenantConfig: () => ({ sandboxNamePrefix: "qm-new-deployment", orgId: "new-owner" }),
    machineName: async (scope) =>
      scope === layers.find((layer) => layer.mode === "rw")?.scopeId ? first.id : undefined,
  });
  const next = await adopted.provision(layers, { env: freshEnv });
  assert.equal(next.id, first.id);
  assert.equal(next.coldStart, false);
  assert.deepEqual(next.env, freshEnv);
  assert.equal(await adopted.readFile(next, "carry-over.txt"), "bytes");
  assert.equal((await adopted.run(next, "echo adopted")).code, 0);
  await adopted.teardown(next);
  await adopted.destroyScope!(layers.find((layer) => layer.mode === "rw")!.scopeId);
}

export async function sandboxApiOverHttp<T extends object>(t: TestContext, client: T): Promise<T> {
  const objects = new Map<string, object>([["client", client]]);
  const errors = new Map<string, unknown>();
  const encode = (value: unknown): unknown => {
    if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString("base64") };
    if (!value || typeof value !== "object") return value;
    const functions = Object.entries(value)
      .filter(([, field]) => typeof field === "function")
      .map(([key]) => key);
    if (functions.length) {
      const id = String(objects.size);
      objects.set(id, value);
      return {
        object: id,
        functions,
        values: Object.fromEntries(Object.entries(value).filter(([, field]) => typeof field !== "function")),
      };
    }
    return value;
  };
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const args = JSON.parse(Buffer.concat(chunks).toString()) as { object: string; method: string; args: unknown[] };
      const target = objects.get(args.object) as Record<string, (...params: unknown[]) => unknown>;
      const decoded = args.args.map((arg) =>
        arg && typeof arg === "object" && "bytes" in arg ? Buffer.from(String(arg.bytes), "base64") : arg,
      );
      let result = await target[args.method]!(...decoded);
      if (result && typeof result === "object" && Symbol.asyncIterator in result) {
        const values = [];
        for await (const value of result as AsyncIterable<unknown>) values.push(value);
        result = values;
      }
      res.end(JSON.stringify({ value: encode(result) }));
    } catch (error) {
      const id = String(errors.size);
      errors.set(id, error);
      res.end(JSON.stringify({ error: id }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  const address = server.address() as { port: number };
  const decode = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value;
    if ("bytes" in value) return Buffer.from(String(value.bytes), "base64");
    if ("object" in value) {
      const descriptor = value as { object: string; functions: string[]; values: Record<string, unknown> };
      return Object.assign(
        descriptor.values,
        Object.fromEntries(
          descriptor.functions.map((method) => [method, (...args: unknown[]) => call(descriptor.object, method, args)]),
        ),
      );
    }
    return value;
  };
  const call = async (object: string, method: string, args: unknown[]): Promise<unknown> => {
    const response = await fetch(`http://127.0.0.1:${address.port}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ object, method, args: args.map(encode) }),
    });
    const body = (await response.json()) as { value?: unknown; error?: string };
    if (body.error !== undefined) throw errors.get(body.error);
    return decode(body.value);
  };
  return new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      if (property === "listRunning")
        return async function* (tags: unknown) {
          for (const id of (await call("client", String(property), [tags])) as string[]) yield id;
        };
      return (...args: unknown[]) => call("client", String(property), args);
    },
  });
}
