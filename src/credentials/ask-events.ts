import type { KeychainAsk, KeychainCredentialMeta } from "./keychain.ts";

export async function askResolutionEvents(
  asks: readonly KeychainAsk[],
  since: number,
  ownerName: (ownerId: string) => string,
  credential: (id: string) => Promise<KeychainCredentialMeta | null>,
): Promise<string> {
  const resolved = asks
    .filter((ask) => ask.status !== "pending" && ask.resolvedAt !== undefined && ask.resolvedAt > since)
    .toSorted((a, b) => a.resolvedAt! - b.resolvedAt!);
  const lines = await Promise.all(
    resolved.map(async (ask) => {
      const service = (await credential(ask.credentialId))?.service;
      const what = service ? `\`${service}\`` : `deleted credential \`${ask.credentialId}\``;
      return `Access request to ${ownerName(ask.ownerId)} for ${what} was ${ask.status}.`;
    }),
  );
  return lines.join("\n");
}
