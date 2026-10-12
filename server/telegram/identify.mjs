// Setup-only helper. The token arrives on stdin, never argv or output.
const username = (process.argv[2] || "").replace(/^@/, "").toLowerCase();
if (!/^[a-z0-9_]+$/.test(username)) {
  console.error("Usage: token-on-stdin | node server/telegram/identify.mjs <your-username>");
  process.exit(1);
}
let token = "";
for await (const chunk of process.stdin) token += chunk;
token = token.trim();
if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) { console.error("Invalid token on stdin."); process.exit(1); }
async function call(method, body) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(25000),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error();
    return result.result;
  } catch { throw new Error("Telegram request failed. Check the token, network and whether another listener is running."); }
}
try {
  if ((await call("getWebhookInfo", {})).url) throw new Error("This token has a webhook. Use a dedicated bot or remove the webhook before polling.");
  console.error(`Send /start to your new bot from @${username}. Waiting up to 60 seconds...`);
  const deadline = Date.now() + 60000; let offset = 0; let found = false;
  while (!found && Date.now() < deadline) {
    const updates = await call("getUpdates", { offset, timeout: 20, allowed_updates: ["message"] });
    for (const update of updates) {
      offset = update.update_id + 1;
      const message = update.message;
      if (message?.chat?.type === "private" && !message.from?.is_bot && message.from?.username?.toLowerCase() === username) {
        console.log(JSON.stringify({ userId: String(message.from.id), chatId: String(message.chat.id) }));
        found = true; break;
      }
    }
  }
  if (!found) throw new Error("No matching private message arrived. Send /start and run this helper again.");
} catch (error) { console.error(error.message); process.exitCode = 1; }
