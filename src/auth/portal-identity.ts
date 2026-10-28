import { mintSignedPayload } from "./signed-token.ts";
import { foreignTenant } from "../tenants/directory.ts";
import {
  verifyPortalIdentity as verifyClaims,
  type PortalIdentity,
} from "../../plugins/chassis/src/portal-identity.ts";

export { PORTAL_IDENTITY_HEADER, type PortalIdentity } from "../../plugins/chassis/src/portal-identity.ts";

export function mintPortalIdentity(claims: PortalIdentity, secret: string): Promise<string> {
  return mintSignedPayload(claims, secret);
}

export function verifyPortalIdentity(token: string, secret: string, nowMs: number): PortalIdentity | null {
  const claims = verifyClaims(token, secret, nowMs);
  return claims && !foreignTenant(claims.t, "portal identity") ? claims : null;
}
