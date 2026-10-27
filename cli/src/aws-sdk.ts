/**
 * One AWS SDK client per service and region, cached for the process. Clients resolve credentials
 * through the SDK's default chain: environment, shared profile (AWS_PROFILE, SSO), then the
 * container or instance role.
 */
const clients = new Map<string, unknown>();

export function awsClient<C>(Client: new (config: { region: string }) => C, region: string): C {
  const key = `${Client.name}:${region}`;
  let client = clients.get(key) as C | undefined;
  if (!client) clients.set(key, (client = new Client({ region })));
  return client;
}
