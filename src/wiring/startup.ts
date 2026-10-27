import { errMessage, reportFailureAs } from "../util/errors.ts";
import type { Config } from "../config.ts";
import type { Stores } from "./stores.ts";
import type { DeploymentLayer } from "./deployment-layer.ts";
import type { Credentials } from "./credentials.ts";

export function buildStartup(
  w: Pick<Stores, "identity" | "configStore"> &
    Pick<DeploymentLayer, "deploymentLayerStore" | "installCatalogs"> &
    Pick<Credentials, "warnShadowedBrokerCredentials"> & { config: Config },
) {
  const { deploymentLayerStore, config, installCatalogs, warnShadowedBrokerCredentials, identity, configStore } = w;

  let started: { ready: Promise<void>; skillsReady: Promise<void> } | undefined;
  // Startup I/O: hydrate stores, load the deployment layer, seed skill catalogs. Runs once, on the first call.
  const startOnce = () => {
    if (started) return started;
    const layerReady = deploymentLayerStore.hydrate();
    const layerSettled = layerReady.then(
      () => undefined,
      (e: unknown) => console.error("[seed] deployment layer not ready:", errMessage(e)),
    );
    const skillsReady = config.seedSkills
      ? Promise.all([
          installCatalogs().catch((e) => console.error("[seed] failed to install seed skills:", errMessage(e))),
          layerSettled,
        ]).then(() => undefined)
      : layerSettled;
    if (config.brokerCredentials?.length) warnShadowedBrokerCredentials(config.brokerCredentials);
    const identityReady = identity.hydrate();
    const configReady = configStore.hydrate?.();
    identityReady.catch(reportFailureAs("startup: hydrate identity", undefined));
    configReady?.catch(reportFailureAs("startup: hydrate configuration", undefined));
    const ready = Promise.all([identityReady, configReady, layerReady]).then(() => {});
    ready.catch(() => {}); // each part reports its own failure; start() callers still see the rejection
    started = { ready, skillsReady };
    return started;
  };
  const skillsReady: PromiseLike<void> = { then: (resolve, reject) => startOnce().skillsReady.then(resolve, reject) };
  return { skillsReady, startOnce };
}

export type StartupModule = ReturnType<typeof buildStartup>;
