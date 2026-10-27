import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
