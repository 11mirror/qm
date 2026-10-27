import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

/** Starts `server` on an ephemeral port and returns its `http://localhost:<port>` base URL. */
export function listenLocal(server: Server): string {
  server.listen(0);
  return `http://localhost:${(server.address() as AddressInfo).port}`;
}
