import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TelegramChannel, type ChannelRuntime, type ChatSnapshot } from "../server/telegram/channel";
import { parseTelegramConfig } from "../server/telegram/config";
import { TelegramTransport, splitMessage } from "../server/telegram/transport";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const config = { botId: "voyager", allowedUserIds: ["42"], allowedChatIds: ["42"] };
const update = (id: number, text = "hello", user = 42, chat = 42, type = "private") => ({ update_id: id, message: { message_id: id, from: { id: user, is_bot: false }, chat: { id: chat, type }, text } });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "telegram-test-")); dirs.push(dir);
  const starts: { agentId: string; text: string; clientMessageId: string }[] = [];
  const sends: { agentId: string; text: string; clientMessageId: string }[] = [];
  const stopped: string[] = [];
  const snapshots = new Map<string, ChatSnapshot>();
  const delivered: { chatId: string; text: string }[] = [];
  let failDelivery = false;
  const runtime: ChannelRuntime = {
    start: async (agentId, text, clientMessageId) => { starts.push({ agentId, text, clientMessageId }); snapshots.set(agentId, { status: "busy" }); },
    send: async (agentId, text, clientMessageId) => { sends.push({ agentId, text, clientMessageId }); snapshots.set(agentId, { status: "busy" }); },
    inspect: async (agentId) => snapshots.get(agentId) ?? null,
    stop: async (agentId) => { stopped.push(agentId); snapshots.set(agentId, { status: "idle" }); },
  };
  const transport = { send: async (chatId: string, text: string) => { if (failDelivery) throw new Error("offline"); delivered.push({ chatId, text }); } };
  const path = join(dir, "telegram-state.json");
  const open = () => TelegramChannel.open(config, path, runtime, transport);
  return { path, open, runtime, starts, sends, stopped, snapshots, delivered, offline: (value: boolean) => { failDelivery = value; } };
}

describe("Telegram conversations", () => {
  it("rejects unlisted senders, unlisted chats, groups and bot senders before creating any chat", async () => {
    const f = await fixture(); const channel = f.open();
    await channel.receive([update(1, "secret", 99), update(2, "secret", 42, 99), update(3, "secret", 42, 42, "group"), { ...update(4), message: { ...update(4).message, from: { id: 42, is_bot: true } } }]);
    await channel.pump();
    expect(f.starts).toEqual([]); expect(f.delivered).toEqual([]); expect(channel.offset).toBe(5);
  });

  it("deduplicates updates and resumes the same thread after a restart", async () => {
    const f = await fixture(); let channel = f.open();
    await channel.receive([update(10), update(10), update(11, "next")]); await channel.pump();
    expect(f.starts).toHaveLength(1); expect(f.sends).toEqual([]);
    const first = f.starts[0]!;
    f.snapshots.set(first.agentId, { status: "idle", clientMessageId: first.clientMessageId, reply: "Hello back" });
    await channel.finished(first.agentId, first.clientMessageId, "Hello back"); await channel.pump();
    expect(f.sends).toEqual([{ agentId: first.agentId, text: "next", clientMessageId: "telegram:42:11" }]);
    channel = f.open(); await channel.receive([update(11, "next"), update(12, "third")]); await channel.pump();
    expect(f.starts).toHaveLength(1); expect(f.sends).toHaveLength(1);
    f.snapshots.set(first.agentId, { status: "idle", clientMessageId: "telegram:42:11", reply: "second answer" });
    await channel.finished(first.agentId, "telegram:42:11", "second answer"); await channel.pump();
    expect(f.sends[1]).toEqual({ agentId: first.agentId, text: "third", clientMessageId: "telegram:42:12" });
    expect(f.delivered.map((entry) => entry.text)).toEqual(["Hello back", "second answer"]);
    expect((await stat(f.path)).mode & 0o777).toBe(0o600);
  });

  it("recovers a completed in-flight reply from the timeline without resending the prompt", async () => {
    const f = await fixture(); const channel = f.open();
    await channel.receive([update(1)]); await channel.pump();
    const first = f.starts[0]!;
    f.snapshots.set(first.agentId, { status: "idle", clientMessageId: first.clientMessageId, reply: "Recovered" });
    await f.open().pump();
    expect(f.starts).toHaveLength(1); expect(f.sends).toEqual([]);
    expect(f.delivered).toEqual([{ chatId: "42", text: "Recovered" }]);
  });

  it("blocks an ambiguous interrupted dispatch instead of repeating its side effects", async () => {
    const f = await fixture(); const channel = f.open();
    await channel.receive([update(1)]); await channel.pump();
    f.snapshots.clear(); const restarted = f.open(); await restarted.pump();
    await restarted.receive([update(2, "next")]); await restarted.pump();
    expect(f.starts).toHaveLength(1); expect(f.sends).toEqual([]);
    expect(f.delivered[0]?.text).toContain("inspect");
  });

  it("retries its durable outbox and ignores unrelated or duplicate turn events", async () => {
    const f = await fixture(); const channel = f.open();
    await channel.receive([update(1)]); await channel.pump(); const first = f.starts[0]!;
    await channel.finished("other", first.clientMessageId, "private");
    await channel.finished(first.agentId, "ui-message", "private");
    f.offline(true); await channel.finished(first.agentId, first.clientMessageId, "answer");
    await expect(channel.pump()).rejects.toThrow("offline");
    f.offline(false); const restarted = f.open();
    await restarted.finished(first.agentId, first.clientMessageId, "answer"); await restarted.pump();
    expect(f.delivered).toEqual([{ chatId: "42", text: "answer" }]);
  });

  it("notifies about permissions without granting them, and stops only its own thread", async () => {
    const f = await fixture(); const channel = f.open();
    await channel.receive([update(1), update(2, "queued")]); await channel.pump();
    const first = f.starts[0]!;
    await channel.permission(first.agentId, "request-1"); await channel.permission(first.agentId, "request-1");
    await channel.pump(); expect(f.delivered).toHaveLength(1); expect(f.delivered[0]?.text).toContain("Paseo");
    await channel.receive([update(3, "/stop")]); await channel.pump();
    expect(f.stopped).toEqual([first.agentId]); expect(f.sends).toEqual([]);
  });

  it("refuses /new while busy and creates a fresh thread after /stop", async () => {
    const f = await fixture(); const channel = f.open();
    await channel.receive([update(1)]); await channel.pump();
    await channel.receive([update(2, "/new")]); await channel.pump();
    expect(f.delivered[0]?.text).toContain("/stop");
    await channel.receive([update(3, "/stop"), update(4, "/new"), update(5, "fresh")]); await channel.pump();
    await channel.pump();
    expect(f.starts).toHaveLength(2); expect(f.starts[1]?.agentId).not.toBe(f.starts[0]?.agentId);
  });

  it("refuses to reuse persisted state for a different bot", async () => {
    const f = await fixture(); await f.open().receive([update(1)]);
    expect(() => TelegramChannel.open({ ...config, botId: "other" }, f.path, {} as never, {} as never)).toThrow("bot");
    expect(await readFile(f.path, "utf8")).not.toContain("token");
  });

  it("never acknowledges another update after a persistence failure", async () => {
    const f = await fixture(); const channel = f.open();
    await mkdir(f.path);
    await expect(channel.receive([update(1)])).rejects.toThrow();
    expect(() => channel.offset).toThrow("persistence");
    await expect(channel.pump()).rejects.toThrow("persistence");
    expect(f.starts).toEqual([]);
  });

  it("recovers a permission notice missed during restart", async () => {
    const f = await fixture(); const channel = f.open();
    await channel.receive([update(1)]); await channel.pump();
    f.snapshots.set(f.starts[0]!.agentId, { status: "attention", permissionIds: ["permission-after-restart"] });
    await f.open().pump();
    expect(f.delivered[0]?.text).toContain("Paseo");
  });

  it("drains an in-flight lookup on shutdown without dispatching the next queued prompt", async () => {
    const f = await fixture(); const channel = f.open();
    await channel.receive([update(1)]); await channel.pump();
    const first = f.starts[0]!;
    await channel.finished(first.agentId, first.clientMessageId, "done");
    await channel.receive([update(2, "must stay queued")]);
    let release!: (snapshot: ChatSnapshot) => void;
    let inspected!: () => void;
    const entered = new Promise<void>((resolve) => { inspected = resolve; });
    f.runtime.inspect = () => { inspected(); return new Promise((resolve) => { release = resolve; }); };
    const pump = channel.pump(); await entered;
    const closing = channel.close(); release({ status: "idle" });
    await pump; await closing;
    expect(f.sends).toEqual([]);
    await expect(channel.receive([update(3)])).rejects.toThrow("closed");
    expect(JSON.parse(await readFile(f.path, "utf8")).chats["42"].pending).toHaveLength(1);
  });

  it("accepts /stop while an outbound Telegram reply is stalled", async () => {
    const f = await fixture(); let release!: () => void; let entered!: () => void;
    const sending = new Promise<void>((resolve) => { entered = resolve; });
    const channel = TelegramChannel.open(config, f.path, f.runtime, { send: async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); } });
    await channel.receive([update(1)]); await channel.pump();
    const first = f.starts[0]!;
    await channel.permission(first.agentId, "permission");
    const pumping = channel.pump(); await sending;
    const stopped = channel.receive([update(2, "/stop")]);
    const result = await Promise.race([stopped.then(() => "stopped"), new Promise((resolve) => setTimeout(() => resolve("blocked"), 100))]);
    release(); await pumping; await stopped;
    expect(result).toBe("stopped"); expect(f.stopped).toEqual([first.agentId]);
  });

  it("keeps delivering to other allowed chats when one chat fails", async () => {
    const f = await fixture(); const sent: string[] = [];
    const channel = TelegramChannel.open({ ...config, allowedUserIds: ["42", "43"], allowedChatIds: ["42", "43"] }, f.path, f.runtime, { send: async (chatId) => { if (chatId === "42") throw new Error("blocked"); sent.push(chatId); } });
    await channel.receive([update(1, "/help"), update(2, "/help", 43, 43)]);
    await expect(channel.pump()).rejects.toThrow("blocked");
    expect(sent).toEqual(["43"]);
  });

  it("labels recovered partial output when completion cannot be verified", async () => {
    const f = await fixture(); const channel = f.open();
    await channel.receive([update(1)]); await channel.pump();
    const first = f.starts[0]!;
    f.snapshots.set(first.agentId, { status: "idle", clientMessageId: first.clientMessageId, reply: "Partial text", completionVerified: false });
    await f.open().pump();
    expect(f.delivered[0]?.text).toContain("completion status is unavailable");
    expect(f.delivered[0]?.text).toContain("Partial text");
  });

  it("closes cleanly when the transport aborts an in-flight delivery", async () => {
    const f = await fixture(); let reject!: (error: Error) => void; let entered!: () => void;
    const sending = new Promise<void>((resolve) => { entered = resolve; });
    const channel = TelegramChannel.open(config, f.path, f.runtime, { send: async () => { entered(); await new Promise<void>((_resolve, fail) => { reject = fail; }); } });
    await channel.receive([update(1, "/help")]);
    const pump = channel.pump(); const failed = expect(pump).rejects.toThrow("aborted"); await sending;
    const closing = channel.close(); reject(new Error("aborted"));
    await failed; await expect(closing).resolves.toBeUndefined();
  });
});

describe("Telegram configuration and transport", () => {
  it("requires explicit private user/chat IDs and an absolute token file when enabled", () => {
    expect(parseTelegramConfig({ enabled: false })).toBeNull();
    expect(() => parseTelegramConfig({ enabled: true, ...config, tokenFile: "relative" })).toThrow();
    expect(() => parseTelegramConfig({ enabled: true, ...config, tokenFile: "/run/token", allowedUserIds: [] })).toThrow();
    expect(parseTelegramConfig({ enabled: true, ...config, tokenFile: "/run/token" })).toMatchObject(config);
  });

  it("splits Unicode text without losing characters or exceeding Telegram limits", () => {
    const text = "😀".repeat(5000); const parts = splitMessage(text);
    expect(parts.join("")).toBe(text); expect(parts.every((part) => part.length <= 4096)).toBe(true);
    expect(parts.every((part) => !/[\uD800-\uDBFF]$/.test(part))).toBe(true);
  });

  it("redacts Telegram's token and error body from transport errors", async () => {
    const transport = new TelegramTransport("123:SECRET", async () => ({ ok: false, status: 401, json: async () => ({ ok: false, description: "123:SECRET" }) }) as never);
    await expect(transport.send("42", "hello")).rejects.toThrow("401");
    await expect(transport.send("42", "hello")).rejects.not.toThrow("SECRET");
  });

  it("posts real Bot API requests and respects Telegram retry_after envelopes", async () => {
    const requests: { url: string; body: unknown }[] = [];
    const server = createServer(async (request, response) => {
      let body = ""; for await (const chunk of request) body += chunk;
      requests.push({ url: request.url!, body: JSON.parse(body) });
      response.setHeader("content-type", "application/json");
      if (request.url === "/getUpdates") response.end(JSON.stringify({ ok: true, result: [update(8)] }));
      else { response.statusCode = 429; response.end(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 12 } })); }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const transport = new TelegramTransport("123:SECRET", (url, options) => fetch(`http://127.0.0.1:${port}/${String(url).split("/").at(-1)}`, options));
    try {
      expect(await transport.updates(8)).toEqual([update(8)]);
      await expect(transport.send("42", "Hi")).rejects.toMatchObject({ status: 429, retryAfter: 12 });
      expect(requests).toEqual([
        { url: "/getUpdates", body: { offset: 8, timeout: 25, allowed_updates: ["message"], limit: 100 } },
        { url: "/sendMessage", body: { chat_id: "42", text: "Hi", link_preview_options: { is_disabled: true } } },
      ]);
    } finally { transport.stop(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("aborts a response whose headers arrived but whose body is stalled during shutdown", async () => {
    let headers!: () => void;
    const receivedHeaders = new Promise<void>((resolve) => { headers = resolve; });
    const server = createServer((_request, response) => { response.setHeader("content-type", "application/json"); response.flushHeaders(); headers(); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    let fetched!: () => void;
    const responseArrived = new Promise<void>((resolve) => { fetched = resolve; });
    const transport = new TelegramTransport("123:SECRET", async (_url, options) => { const response = await fetch(`http://127.0.0.1:${port}`, options); fetched(); return response; });
    const pending = transport.updates(0);
    try {
      await receivedHeaders; await responseArrived;
      // Allow the transport to start consuming the body before cancellation.
      await new Promise((resolve) => setTimeout(resolve, 10)); transport.stop();
      const result = await Promise.race([pending.then(() => "resolved", () => "aborted"), new Promise((resolve) => setTimeout(() => resolve("stalled"), 100))]);
      expect(result).toBe("aborted");
    } finally { server.closeAllConnections(); await pending.catch(() => {}); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
