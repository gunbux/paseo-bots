import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { pluginDataPath } from "../bot-home";
import type { BotsHost } from "../host";
import type { Relay } from "../relay";
import { TelegramChannel } from "./channel";
import { parseTelegramConfig } from "./config";
import { PaseoTelegramRuntime, telegramTurn } from "./runtime";
import { TelegramApiError, TelegramTransport } from "./transport";

/** Owns timers, the long poll and optional local API bootstrap for this plugin. */
export class TelegramService {
  private stopped = false;
  private channel: TelegramChannel | null = null;
  private transport: TelegramTransport | null = null;
  private pumpTimer: ReturnType<typeof setInterval> | null = null;
  private pumping: Promise<void> | null = null;
  private bootstrap: ReturnType<typeof execFile> | null = null;
  private readonly waits = new Set<() => void>();
  private readonly loop: Promise<void>;

  constructor(private readonly host: BotsHost, private readonly relay: Relay) {
    this.loop = this.start().catch(() => {
      if (!this.stopped) console.error("paseo-bots: Telegram could not start. Check its configuration, token file and state file.");
    });
  }
  private sleep(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this.waits.delete(done); resolve(); };
      const timer = setTimeout(done, ms); this.waits.add(done);
    });
  }
  private async start(): Promise<void> {
    const path = process.env.PASEO_BOTS_TELEGRAM_CONFIG || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "paseo", "telegram.json");
    let raw: string;
    try { raw = await readFile(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const config = parseTelegramConfig(JSON.parse(raw));
    if (!config || this.stopped) return;
    const token = (await readFile(config.tokenFile, "utf8")).trim();
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error("Invalid Telegram token file.");
    this.transport = new TelegramTransport(token);
    this.channel = TelegramChannel.open(config, join(pluginDataPath(), "telegram-state.json"), new PaseoTelegramRuntime(this.host, this.relay, config.botId), this.transport);

    while (!this.stopped && !this.host.paseo) {
      if (config.bootstrapCommand) {
        const [command, ...args] = config.bootstrapCommand;
        await new Promise<void>((resolve) => {
          this.bootstrap = execFile(command, args, { timeout: 10000, maxBuffer: 65536 }, () => { this.bootstrap = null; resolve(); });
        });
      }
      if (!this.host.paseo) await this.sleep(5000);
    }
    if (this.stopped) return;
    // Polling is independent of agent turns; /stop remains responsive while busy.
    this.pumpTimer = setInterval(() => void this.pump(), 1000);
    void this.pump();
    console.info("paseo-bots: Telegram listener started for its configured bot.");
    while (!this.stopped) {
      try { await this.channel.receive(await this.transport.updates(this.channel.offset)); }
      catch (error) {
        if (this.stopped) break;
        const status = error instanceof TelegramApiError ? error.status : "state";
        console.error(`paseo-bots: Telegram polling failed (${status}); retrying.`);
        await this.sleep((error instanceof TelegramApiError ? error.retryAfter : 5) * 1000);
      }
    }
  }
  private pump(): Promise<void> {
    if (this.stopped || this.pumping || !this.channel) return this.pumping ?? Promise.resolve();
    this.pumping = this.channel.pump().catch(async (error: unknown) => {
      if (!this.stopped) {
        console.error("paseo-bots: Telegram delivery or agent lookup failed; retrying.");
        await this.sleep((error instanceof TelegramApiError ? error.retryAfter : 5) * 1000);
      }
    }).finally(() => { this.pumping = null; });
    return this.pumping;
  }
  finished(event: PluginLifecycleEvents["agent.turn_ended"]): void {
    if (!this.channel || this.stopped) return;
    const turn = telegramTurn(event.timeline);
    const text = event.outcome.kind === "failed" ? "The turn failed. Check Paseo for details." : event.outcome.kind === "canceled" ? "The turn was canceled." : turn.reply;
    void this.channel.finished(event.agent.id, turn.clientMessageId, text).catch(() => console.error("paseo-bots: Telegram could not record a completed turn."));
  }
  permission(event: PluginLifecycleEvents["agent.permission_requested"]): void {
    if (!this.channel || this.stopped) return;
    void this.channel.permission(event.agent.id, event.request.id).catch(() => console.error("paseo-bots: Telegram could not record a permission notice."));
  }
  async stop(): Promise<void> {
    this.stopped = true;
    const drain = this.channel?.close();
    if (this.pumpTimer) clearInterval(this.pumpTimer);
    this.transport?.stop(); this.bootstrap?.kill();
    for (const done of this.waits) done();
    await Promise.all([this.loop, this.pumping, drain]);
  }
}
