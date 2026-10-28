import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as httpServer, request } from "node:http";
import { createServer as tcpServer, connect, type AddressInfo } from "node:net";
import { endpointTransport } from "../../src/deploy/endpoint-transport.ts";

const listen = (server: ReturnType<typeof tcpServer> | ReturnType<typeof httpServer>): Promise<number> =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));

test("deployment transport dials the private host through SOCKS without local DNS", async (t) => {
  const upstream = httpServer((_req, res) => res.end("private app"));
  const upstreamPort = await listen(upstream);
  let dialedHost: string | undefined;
  const proxy = tcpServer((socket) => {
    let stage = 0;
    let pending = Buffer.alloc(0);
    const handshake = (bytes: Buffer) => {
      pending = Buffer.concat([pending, bytes]);
      if (stage === 0) {
        if (pending.length < 2 || pending.length < 2 + pending[1]!) return;
        pending = pending.subarray(2 + pending[1]!);
        socket.write(Buffer.from([5, 0]));
        stage = 1;
      }
      if (stage !== 1 || pending.length < 5) return;
      const hostLength = pending[4]!;
      if (pending.length < 7 + hostLength) return;
      assert.equal(pending[3], 3);
      dialedHost = pending.subarray(5, 5 + hostLength).toString();
      const remote = connect(upstreamPort, "127.0.0.1", () => {
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
        socket.off("data", handshake);
        remote.pipe(socket);
        socket.pipe(remote);
      });
      remote.on("error", () => socket.destroy());
      socket.on("close", () => remote.destroy());
      stage = 2;
    };
    socket.on("data", handshake);
  });
  const port = await listen(proxy);
  t.after(() => {
    proxy.close();
    upstream.close();
  });
  const transport = endpointTransport({ host: "private.flycast", port: 8080, socksProxyPort: port });
  const body = await new Promise<string>((resolve, reject) => {
    const req = request({ hostname: "private.flycast", port: 8080, ...transport }, (response) => {
      let text = "";
      response.on("data", (data) => {
        text += data;
      });
      response.on("end", () => resolve(text));
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(body, "private app");
  assert.equal(dialedHost, "private.flycast");
});

test("endpoint transport is absent for direct providers and rejects invalid local proxy ports", () => {
  assert.deepEqual(endpointTransport({ host: "direct", port: 80 }), {});
  for (const socksProxyPort of [0, 80, 65536, NaN, 1.2])
    assert.throws(() => endpointTransport({ host: "private", port: 80, socksProxyPort }), /proxy port/);
});
