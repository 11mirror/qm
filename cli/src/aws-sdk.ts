const clients = new Map<string, unknown>();

export function awsClient<C>(Client: new (config: { region: string }) => C, region: string): C {
  const key = `${Client.name}:${region}`;
  let client = clients.get(key) as C | undefined;
  if (!client) clients.set(key, (client = new Client({ region })));
  return client;
}
