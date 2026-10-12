import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { BOT_LABEL } from "../../shared/bot";
import { startChat } from "../chats";
import type { BotsHost } from "../host";
import type { Relay } from "../relay";
import type { ChannelRuntime, ChatSnapshot } from "./channel";

export const TELEGRAM_LABEL = "paseo-bots.telegram";
const execute = promisify(execFile);
type Timeline = PluginLifecycleEvents["agent.turn_ended"]["timeline"];

/** Correlate a reply with the actual Telegram prompt, including after restart. */
export function telegramTurn(timeline: Timeline): { clientMessageId: string; reply: string } {
  const start = timeline.findLastIndex((item) => item.type === "user_message");
  const user = timeline[start];
  return {
    clientMessageId: user?.type === "user_message" ? user.clientMessageId ?? "" : "",
    reply: timeline.slice(start + 1).filter((item) => item.type === "assistant_message").map((item) => item.text).join("\n\n").trim(),
  };
}

export class PaseoTelegramRuntime implements ChannelRuntime {
  constructor(private readonly host: BotsHost, private readonly relay: Relay, private readonly botId: string) {}

  private async owned(agentId: string) {
    const handle = this.host.requirePaseo().agents.ref(agentId);
    const snapshot = await handle.refresh();
    if (!snapshot || snapshot.agent.archivedAt) return null;
    if (snapshot.agent.labels?.[BOT_LABEL] !== this.botId || snapshot.agent.labels?.[TELEGRAM_LABEL] !== "true") throw new Error("Telegram conversation no longer belongs to the configured bot.");
    return { handle, agent: snapshot.agent };
  }

  async start(agentId: string, text: string, clientMessageId: string): Promise<void> {
    const bot = await this.host.bot(this.botId);
    if (!bot) throw new Error("Telegram bot is not configured on this host.");
    await startChat(this.host, this.relay, bot, {
      agentId, clientMessageId, prompt: text, title: `Telegram · ${bot.name}`, labels: { [TELEGRAM_LABEL]: "true" },
      channelInstructions: "This conversation arrives from the user's private Telegram chat. Your assistant reply is delivered to that chat automatically. Answer concisely in plain text. Do not use Telegram tools just to deliver your reply; use them only when the user requests a separate outbound message.",
    });
  }
  async send(agentId: string, text: string, clientMessageId: string): Promise<void> {
    const owned = await this.owned(agentId);
    if (!owned) throw new Error("Telegram conversation is unavailable.");
    await owned.handle.send(text, { messageId: clientMessageId });
  }
  async inspect(agentId: string): Promise<ChatSnapshot | null> {
    const owned = await this.owned(agentId);
    if (!owned) return null;
    const { agent, handle } = owned;
    if (agent.pendingPermissions?.length) return { status: "attention", permissionIds: agent.pendingPermissions.map((request) => request.id) };
    if (agent.status === "running" || agent.status === "initializing") return { status: "busy" };
    const page = await handle.timeline.refetch({ limit: 500 });
    const turn = telegramTurn(page.entries.map((entry) => entry.item));
    // The SDK snapshot does not retain a canceled/completed outcome. Only a
    // live turn_ended hook verifies completion; recovered text may be partial.
    return { status: "idle", ...turn, completionVerified: !!agent.lastError, reply: agent.lastError ? "The turn failed. Check Paseo for details." : turn.reply };
  }
  async stop(agentId: string): Promise<void> {
    if (!(await this.owned(agentId))) return;
    // The SDK's agent handle has no interrupt method in Paseo 0.9.2.
    // Use the matching CLI with an exact stored agent ID, never a user argument.
    const args = [...(process.env.PASEO_HOME ? ["--home", process.env.PASEO_HOME] : []), "stop", agentId, "--json"];
    await execute(process.env.PASEO_CLI || "paseo", args, { timeout: 15000, maxBuffer: 65536 });
  }
}
