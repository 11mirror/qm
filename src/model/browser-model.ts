import { resolveIndividualAuthRouting } from "../core/individual-auth-routing.ts";
import type { ScopedConfigStore } from "../resolution/config-store.ts";
import type { UserModelCredentialStore } from "./user-model-credential-store.ts";
import { scopeId } from "../types.ts";
import { tenant } from "../tenant.ts";

export async function resolveBrowserModel(input: {
  actorId: string;
  config?: ScopedConfigStore;
  credentials?: UserModelCredentialStore;
  companyModel?: string;
}) {
  const account = (await input.config?.getModelAccountDurable(input.actorId)) ?? "company";
  const personalScope = scopeId("personal", input.actorId);
  const requested = (await input.config?.getRuntimeSelectionDurable(personalScope))?.modelId;
  if (account === "company") {
    const model =
      requested ?? (await input.config?.getRuntimeSelectionDurable(tenant().orgScope))?.modelId ?? input.companyModel;
    return { account, model, routing: null };
  }
  const [anthropic, openai] = await Promise.all([
    account === "openai" ? null : input.credentials?.get(input.actorId, "anthropic"),
    account === "anthropic" ? null : input.credentials?.get(input.actorId, "openai"),
  ]);
  const routing = resolveIndividualAuthRouting(anthropic ?? null, openai ?? null, requested);
  return { account, model: routing?.model, routing };
}
