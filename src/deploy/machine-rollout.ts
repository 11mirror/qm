import { swallow } from "../util/errors.ts";

export interface AppMachine<C> {
  id: string;
  config?: C;
}

export interface MachineRollout<C> {
  create(config: C): Promise<AppMachine<C>>;
  update(id: string, config: C): Promise<void>;
  destroy(id: string): Promise<void>;
  route(id: string, serving: boolean): Promise<void>;
  ready(id: string, config: C): Promise<void>;
}

export async function replaceAppMachine<C>(
  driver: MachineRollout<C>,
  previous: readonly AppMachine<C>[],
  config: C,
): Promise<void> {
  const created = await driver.create(config);
  try {
    await driver.ready(created.id, config);
    for (const machine of previous) await driver.route(machine.id, false);
    await driver.route(created.id, true);
  } catch (error) {
    for (const machine of previous)
      await driver.route(machine.id, true).catch((e) => swallow("deploy: restore previous routing", e));
    await driver.destroy(created.id).catch((e) => swallow("deploy: abandon failed replacement", e));
    throw error;
  }
  for (const machine of previous)
    await driver.destroy(machine.id).catch((e) => swallow("deploy: remove retired machine", e));
}

export async function updateAppMachine<C>(
  driver: MachineRollout<C>,
  previous: AppMachine<C> | null,
  config: C,
): Promise<void> {
  if (!previous) return replaceAppMachine(driver, [], config);
  if (!previous.config) throw new Error("deploy: existing machine has no rollback configuration");
  const accepted = previous.config;
  try {
    await driver.update(previous.id, config);
    await driver.ready(previous.id, config);
    await driver.route(previous.id, true);
  } catch (error) {
    await driver.update(previous.id, accepted);
    await driver.ready(previous.id, accepted);
    await driver.route(previous.id, true);
    throw error;
  }
}
