import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { TelegramConfig } from "./config";
import { splitMessage } from "./transport";

export type ChatSnapshot = { status: "busy" | "attention" | "idle"; clientMessageId?: string; reply?: string; permissionIds?: string[]; completionVerified?: boolean };
export interface ChannelRuntime {
  start(agentId: string, text: string, clientMessageId: string): Promise<void>;
  send(agentId: string, text: string, clientMessageId: string): Promise<void>;
  inspect(agentId: string): Promise<ChatSnapshot | null>;
  stop(agentId: string): Promise<void>;
}
const messageSchema = z.object({ text: z.string(), clientMessageId: z.string() });
const conversationSchema = z.object({
  agentId: z.string().nullable(), active: messageSchema.nullable(), pending: z.array(messageSchema),
  outbox: z.array(z.string()), notices: z.array(z.string()), blocked: z.boolean(),
});
const stateSchema = z.object({ version: z.literal(1), botId: z.string(), offset: z.number().int().nonnegative(), chats: z.record(z.string().regex(/^[1-9]\d*$/), conversationSchema) });
type Conversation = z.infer<typeof conversationSchema>;
const updateSchema = z.object({ update_id: z.number().int().nonnegative(), message: z.object({
  from: z.object({ id: z.number().int().positive(), is_bot: z.boolean() }),
  chat: z.object({ id: z.number().int(), type: z.string() }), text: z.string().max(20000).optional(),
}).optional() });
type Config = Pick<TelegramConfig, "botId" | "allowedUserIds" | "allowedChatIds">;
interface Sender { send(chatId: string, text: string): Promise<void> }
const emptyChat = (): Conversation => ({ agentId: null, active: null, pending: [], outbox: [], notices: [], blocked: false });
const uncertain = "A Telegram turn was interrupted and its result is uncertain. Please inspect the conversation in Paseo, then use /new. I have not repeated the prompt.";

export class TelegramChannel {
  private serial: Promise<unknown> = Promise.resolve();
  private persistenceFailure: Error | null = null;
  private closed = false;
  private pumping: Promise<void> | null = null;
  private constructor(private readonly config: Config, private readonly path: string, private readonly runtime: ChannelRuntime, private readonly sender: Sender, private readonly state: z.infer<typeof stateSchema>) {}

  static open(config: Config, path: string, runtime: ChannelRuntime, sender: Sender): TelegramChannel {
    let state: z.infer<typeof stateSchema> = { version: 1, botId: config.botId, offset: 0, chats: {} };
    try { state = stateSchema.parse(JSON.parse(readFileSync(path, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Invalid Telegram state; restore it before starting the listener."); }
    if (state.botId !== config.botId) throw new Error("Telegram state belongs to a different bot; move it aside before changing botId.");
    return new TelegramChannel(config, path, runtime, sender, state);
  }
  get offset(): number { if (this.persistenceFailure) throw this.persistenceFailure; return this.state.offset; }
  private run<T>(work: () => Promise<T>, allowClosed = false): Promise<T> {
    const result = this.serial.then(() => { if (this.closed && !allowClosed) throw new Error("Telegram channel is closed."); if (this.persistenceFailure) throw this.persistenceFailure; return work(); });
    this.serial = result.catch(() => undefined);
    return result;
  }
  private save(): void {
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const file = openSync(temp, "wx", 0o600);
      try { writeFileSync(file, JSON.stringify(this.state)); fsyncSync(file); } finally { closeSync(file); }
      renameSync(temp, this.path);
      const directory = openSync(dirname(this.path), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch {
      try { unlinkSync(temp); } catch { /* No temp file if the write failed early. */ }
      this.persistenceFailure = new Error("Telegram persistence failed. Fix storage and reload the plugin before continuing.");
      throw this.persistenceFailure;
    }
  }
  private allowed(chatId: string): boolean { return this.config.allowedChatIds.includes(chatId) && this.config.allowedUserIds.includes(chatId); }
  private reply(chat: Conversation, text: string): void { chat.outbox.push(...splitMessage(text)); }

  receive(updates: unknown[]): Promise<void> { return this.run(async () => {
    for (const raw of updates) {
      // Advance even for unsupported update kinds, but never dispatch malformed input.
      const header = z.object({ update_id: z.number().int().nonnegative() }).safeParse(raw);
      if (!header.success || header.data.update_id < this.state.offset) continue;
      const parsed = updateSchema.safeParse(raw);
      if (parsed.success && parsed.data.message) {
        const message = parsed.data.message; const chatId = String(message.chat.id);
        if (message.chat.type === "private" && !message.from.is_bot && String(message.from.id) === chatId && this.allowed(chatId)) {
          const chat = this.state.chats[chatId] ??= emptyChat();
          const text = message.text?.trim();
          if (!text) this.reply(chat, "This channel accepts text messages. Send /help for commands.");
          else if (text.startsWith("/")) await this.command(chat, text);
          else if (chat.blocked) this.reply(chat, uncertain);
          else if (chat.pending.length >= 30) this.reply(chat, "The message queue is full. Wait for replies or use /stop.");
          else chat.pending.push({ text, clientMessageId: `telegram:${chatId}:${header.data.update_id}` });
        }
      }
      this.state.offset = header.data.update_id + 1;
      this.save();
    }
  }); }

  private async command(chat: Conversation, text: string): Promise<void> {
    const command = text.split(/\s/, 1)[0]!.split("@", 1)[0];
    if (command === "/start" || command === "/help") this.reply(chat, "Messages go to your configured Paseo bot. /new starts a fresh conversation. /stop cancels the current turn and clears queued messages. Approve tool requests in Paseo.");
    else if (command === "/stop") {
      if (chat.agentId) await this.runtime.stop(chat.agentId);
      chat.pending = []; chat.active = null;
      this.reply(chat, "Stopped. Queued messages cleared.");
    } else if (command === "/new") {
      const snapshot = chat.agentId ? await this.runtime.inspect(chat.agentId) : null;
      if (snapshot && snapshot.status !== "idle") { this.reply(chat, "The conversation is busy. Send /stop before /new."); return; }
      chat.agentId = null; chat.active = null; chat.pending = []; chat.blocked = false; chat.notices = [];
      this.reply(chat, "Your next message will start a fresh conversation in Paseo.");
    } else this.reply(chat, "Unknown command. Send /help for commands.");
  }

  pump(): Promise<void> {
    if (this.pumping) return this.pumping;
    this.pumping = this.pumpChats().finally(() => { this.pumping = null; });
    return this.pumping;
  }

  private async pumpChats(): Promise<void> {
    let failure: unknown;
    for (const chatId of Object.keys(this.state.chats)) {
      if (this.closed) return;
      if (!this.allowed(chatId)) continue;
      try {
        await this.run(() => this.dispatch(chatId));
        if (this.closed) return;
        const text = await this.run(async () => this.state.chats[chatId]!.outbox[0]);
        if (!text) continue;
        // Network delivery must not hold the state queue: /stop can still run.
        // Send at most one chunk per chat per tick so a long reply is bounded.
        await this.sender.send(chatId, text);
        await this.run(async () => {
          const chat = this.state.chats[chatId]!;
          if (chat.outbox[0] === text) { chat.outbox.shift(); this.save(); }
        }, true);
        // A delivered reply can release the next queued prompt immediately.
        if (!this.closed) await this.run(() => this.dispatch(chatId));
      } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }

  private async dispatch(chatId: string): Promise<void> {
    const chat = this.state.chats[chatId]!;
    const snapshot = chat.agentId ? await this.runtime.inspect(chat.agentId) : null;
    if (this.closed) return;
    if (chat.active && snapshot?.status === "attention") {
      for (const requestId of snapshot.permissionIds ?? []) this.recordPermission(chat, requestId);
    }
    if (chat.active && (!snapshot || snapshot.status === "idle")) {
      if (snapshot?.clientMessageId === chat.active.clientMessageId) {
        const notice = snapshot.completionVerified === false ? "Recovered output; completion status is unavailable. Check Paseo if the turn was interrupted.\n\n" : "";
        this.reply(chat, notice + (snapshot.reply?.trim() || "No text reply was recorded. Check Paseo for details."));
      }
      else { this.reply(chat, uncertain); chat.blocked = true; }
      chat.active = null; this.save();
    }
    if (chat.active || chat.blocked || chat.outbox.length || !chat.pending.length || (snapshot && snapshot.status !== "idle")) return;
    const fresh = !snapshot;
    if (fresh) chat.agentId = randomUUID();
    chat.active = chat.pending.shift()!;
    this.save();
    try {
      if (fresh) await this.runtime.start(chat.agentId!, chat.active.text, chat.active.clientMessageId);
      else await this.runtime.send(chat.agentId!, chat.active.text, chat.active.clientMessageId);
    } catch {
      // An RPC failure can mean the request was accepted but the response was lost.
      chat.blocked = true; this.reply(chat, uncertain); this.save();
    }
  }

  finished(agentId: string, clientMessageId: string, text: string): Promise<void> { return this.run(async () => {
    for (const [chatId, chat] of Object.entries(this.state.chats)) {
      if (!this.allowed(chatId) || chat.agentId !== agentId || !chat.active || chat.active.clientMessageId !== clientMessageId) continue;
      this.reply(chat, text.trim() || "The turn finished without a text reply. Check Paseo for details.");
      chat.active = null; this.save();
    }
  }); }

  permission(agentId: string, requestId: string): Promise<void> { return this.run(async () => {
    for (const [chatId, chat] of Object.entries(this.state.chats)) {
      if (!this.allowed(chatId) || chat.agentId !== agentId || !chat.active || chat.notices.includes(requestId)) continue;
      this.recordPermission(chat, requestId);
    }
  }); }
  private recordPermission(chat: Conversation, requestId: string): void {
    if (chat.notices.includes(requestId)) return;
    chat.notices = [...chat.notices.slice(-99), requestId];
    this.reply(chat, "Your bot needs approval. Open this conversation in Paseo to review the tool request, or send /stop."); this.save();
  }
  async close(): Promise<void> { this.closed = true; await Promise.allSettled([this.serial, this.pumping]); }
}
