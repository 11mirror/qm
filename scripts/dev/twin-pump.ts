import { startEventPump, TwinAdmin } from "../../test/live-slack/arga.ts";
import { SlackClient } from "../../test/live-slack/slack.ts";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} is required`);
    process.exit(2);
  }
  return v;
}

const admin = new TwinAdmin(requireEnv("ARGA_TWIN_ADMIN_URL"), requireEnv("ARGA_TWIN_PROXY_TOKEN"));
const bot = new SlackClient(requireEnv("SLACK_BOT_TOKEN"), requireEnv("SLACK_API_URL"));
const targetUrl = `${(process.env.CORE_API_URL ?? "http://localhost:8181").replace(/\/+$/, "")}/slack/events`;

const { userId } = await bot.authTest();
const pump = startEventPump({
  admin,
  signingSecret: requireEnv("SLACK_SIGNING_SECRET"),
  targetUrl,
  botUserId: userId,
});
await pump.ready;
console.log(`twin event pump running → ${targetUrl} (bot <@${userId}>)`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void pump.stop().then(() => process.exit(0));
  });
}
