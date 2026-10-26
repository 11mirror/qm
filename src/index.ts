import "./instrument.ts";
import type { Server } from "node:http";
import { stopWithBackstop } from "./wiring.ts";
import { shutdownOnUncaught } from "./util/process-guard.ts";
import { startWebEdge } from "./web-edge.ts";
import { multitenant } from "../plugins/chassis/src/tenant-workers.ts";
import { bootTenant, type BootedTenant } from "./tenants/boot.ts";
import { startMultitenant } from "./tenants/host.ts";

async function bootSingleTenant(): Promise<{ tenants: BootedTenant[]; servers: Server[] }> {
  const servers: Server[] = [];
  const booted = await bootTenant(process.env, async (server, config) => {
    if (server) {
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(config.port, resolve));
      console.log(
        `[qm] listening on :${config.port} (roles=${config.roles.join(",")}, org=${config.orgId}, ` +
          `runStore=${config.runStore}, workers=${config.workers}, backgroundWork=${config.backgroundWorkEnabled})`,
      );
      if (config.publicPort)
        servers.push(
          ...(await startWebEdge(
            { publicPort: config.publicPort, corePort: config.port, orgId: config.orgId },
            process.env,
          )),
        );
    } else {
      console.log(
        `[qm] running without the api role (roles=${config.roles.join(",")}, org=${config.orgId}, workers=${config.workers})`,
      );
    }
  });
  return { tenants: [booted], servers };
}

const { tenants, servers, stopWorkers } = multitenant(process.env)
  ? await startMultitenant(process.env)
  : { ...(await bootSingleTenant()), stopWorkers: async () => {} };
const home = tenants[0]!;

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[qm] ${signal} received, shutting down`);
  for (const booted of tenants) booted.beginShutdown();
  for (const server of servers) {
    server.close();
    server.closeIdleConnections();
  }
  stopWithBackstop(
    {
      async stop() {
        await Promise.all(tenants.map((booted) => booted.stop()));
        await stopWorkers();
      },
      releaseInFlightRuns: async () => {
        await Promise.all(tenants.map((booted) => booted.releaseInFlightRuns()));
      },
    },
    home.config.shutdownDrainMs,
    "qm",
    () => {
      for (const server of servers) server.closeAllConnections();
    },
  );
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
shutdownOnUncaught("qm", shutdown);
