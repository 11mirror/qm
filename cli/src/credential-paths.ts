export const BASE_EPHEMERAL_CRED_LINKS: ReadonlyArray<{ rel: string; kind: "dir" | "file" }> = [
  { rel: ".aws", kind: "dir" },
  { rel: ".netrc", kind: "file" },
  { rel: ".config/gh", kind: "dir" },
  { rel: ".config/glab", kind: "dir" },
  { rel: ".config/glab-cli", kind: "dir" },
  { rel: ".config/gcloud", kind: "dir" },
];

export const DISPLACED_DIR_REL = ".agent-displaced";

export interface CredentialPathSpec {
  path: string;
  kind: "file" | "directory";
}

const DURABLE_CREDENTIALS = [
  { path: ".ssh", kind: "directory" },
  { path: ".git-credentials", kind: "file" },
] as const satisfies readonly CredentialPathSpec[];

export const DURABLE_CREDENTIAL_PATHS: readonly string[] = DURABLE_CREDENTIALS.map((entry) => entry.path);

export const CREDENTIAL_PATH_RE = /^[A-Za-z0-9._/@+-]+$/;

export function builtInCredentialPaths(): CredentialPathSpec[] {
  return [
    ...BASE_EPHEMERAL_CRED_LINKS.map(({ rel, kind }) => ({
      path: rel,
      kind: kind === "dir" ? ("directory" as const) : ("file" as const),
    })),
    ...DURABLE_CREDENTIALS,
  ];
}
