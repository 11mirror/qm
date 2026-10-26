import { settle } from "./settle.ts";

export async function recorded(list: () => Promise<readonly unknown[]>, count: number): Promise<void> {
  await settle(async () => (await list()).length >= count, 3_000);
}
