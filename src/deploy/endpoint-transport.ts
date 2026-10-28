import { SocksProxyAgent } from "socks-proxy-agent";
import { LRUCache } from "lru-cache";
import type { DeployEndpoint } from "./deploy-provider.ts";

const agents = new LRUCache<number, SocksProxyAgent>({ max: 100, dispose: (agent) => agent.destroy() });

export function endpointTransport(endpoint: DeployEndpoint) {
  const port = endpoint.socksProxyPort;
  if (port === undefined) return {};
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid deployment proxy port");
  let agent = agents.get(port);
  if (!agent) {
    agent = new SocksProxyAgent(`socks5h://127.0.0.1:${port}`);
    agents.set(port, agent);
  }
  return { agent };
}
