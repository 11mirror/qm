export async function pushStatus(url: string): Promise<number> {
  const parsed = new URL(url);
  const authorization = `Basic ${Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString("base64")}`;
  parsed.username = "";
  parsed.password = "";
  parsed.pathname += "/git-receive-pack";
  return (
    await fetch(parsed, {
      method: "POST",
      headers: { authorization, "content-type": "application/x-git-receive-pack-request" },
      body: Buffer.alloc(0),
    })
  ).status;
}
