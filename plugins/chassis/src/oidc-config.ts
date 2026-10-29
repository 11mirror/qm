export interface OidcConfig {
  authEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  redirectUri: string;
  issuer: string;
  jwksUri: string;
  expectedTeamId?: string;
  prompt?: string;
  hostedDomain?: string;
  headers?: Record<string, string>;
}

export interface PrincipalRule {
  claim: "sub" | "email";
  allowedEmailDomain?: string;
  allowedEmails?: readonly string[];
  requireCoreAdmission?: boolean;
}
