export function connectorTokenNote(host: string): string {
  return `proxy ${host}; any method and path; call \`$AGENT_API_URL/v1/credentials/http/${host}/<path>\` with header \`x-agent-capability: $AGENT_CREDENTIAL_TOKEN\` and the broker adds the OAuth token`;
}
