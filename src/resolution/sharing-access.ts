import type { FileArtifactStore } from "../files/file-artifact-store.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { GrantedHandle, Principal, ScopeId, TurnOrigin } from "../types.ts";
import { parseScopeId, personalScope } from "../types.ts";
import type { IsCurrentSharedScopeMember } from "./scope-membership.ts";

interface SharingSourcesInput {
  actor: Principal;
  origin: TurnOrigin;
  trustedLiveHuman: boolean;
  targetScope: ScopeId;
  sessions: Pick<SessionStore, "participantScopes">;
  isCurrentSharedScopeMember?: IsCurrentSharedScopeMember;
}

export async function isOpenScopeMember(input: {
  actorId: string;
  scope: ScopeId;
  isCurrentSharedScopeMember: IsCurrentSharedScopeMember;
}): Promise<boolean> {
  const { kind } = parseScopeId(input.scope);
  return (
    (kind === "channel" || kind === "group") && (await input.isCurrentSharedScopeMember(input.actorId, input.scope))
  );
}

export async function sharingSourcesForTurn(input: SharingSourcesInput): Promise<ScopeId[]> {
  if (
    input.actor.type !== "internal" ||
    (input.origin.kind !== "human" && !(input.origin.kind === "ambient" && input.origin.live === true)) ||
    !input.trustedLiveHuman ||
    !input.isCurrentSharedScopeMember
  )
    return [];
  const targetKind = parseScopeId(input.targetScope).kind;
  const personal = personalScope(input.actor.id);
  if (targetKind === "channel" || targetKind === "group") {
    return (await input.isCurrentSharedScopeMember(input.actor.id, input.targetScope)) ? [personal] : [];
  }
  if (targetKind !== "personal") return [];
  const rooms = (await input.sessions.participantScopes(input.actor.id).catch(() => []))
    .filter((scope) => {
      const kind = parseScopeId(scope.scopeId).kind;
      return kind === "channel" || kind === "group";
    })
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  const sources: ScopeId[] = [];
  for (const room of rooms) {
    if (await input.isCurrentSharedScopeMember(input.actor.id, room.scopeId)) sources.push(room.scopeId);
  }
  return sources;
}

function handleSource(scope: ScopeId): string {
  return scope.replace(/[^A-Za-z0-9._-]+/g, "-");
}

function handlePath(path: string): string {
  return path
    .split(/[\\/]+/)
    .filter((part) => part && part !== "." && part !== "..")
    .map(handleSource)
    .join("/");
}

export async function carriedFileHandles(
  sourceScopes: readonly ScopeId[],
  files: Pick<FileArtifactStore, "listOwnedByScopes">,
): Promise<GrantedHandle[]> {
  const handles = new Map<string, GrantedHandle>();
  for (const sourceScope of sourceScopes) {
    let cursor: string | undefined;
    do {
      const page = await files.listOwnedByScopes([sourceScope], cursor ? { cursor } : {});
      for (const file of page.files) {
        handles.set(file.id, {
          carried: true,
          handlePath: `shared/open-${handleSource(sourceScope)}/${file.id}/${handlePath(file.name)}`,
          ownerScopeId: sourceScope,
          fileId: file.id,
          permission: "read",
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
  }
  return [...handles.values()];
}
