import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PaseoTelegramRuntime, telegramTurn, TELEGRAM_LABEL } from "../server/telegram/runtime";
import { Relay } from "../server/relay";
import { BOT_LABEL } from "../shared/bot";
import { fakeHost, makeBot } from "./helpers";

let home: string | undefined;
afterEach(async () => { if (home) await rm(home, { recursive: true, force: true }); delete process.env.PASEO_HOME; });

describe("Paseo Telegram integration", () => {
  it("preserves agent and prompt identities while creating a real bot chat with its configured instructions", async () => {
    home = await mkdtemp(join(tmpdir(), "telegram-runtime-")); process.env.PASEO_HOME = home;
    const bot = makeBot({ id: "voyager", name: "Voyager", model: "sonnet", soul: "Use TREK for travel plans.", cwd: home });
    const host = fakeHost([bot]); let created: any;
    const workspace = { current: () => ({ projectId: "bots", projectRootPath: home }), setTitle: async () => {}, agents: { create: async (input: unknown) => { created = input; return { id: "agent-1" }; } } };
    host.attach({ workspaces: { list: async () => ({ entries: [] }), create: async () => workspace }, config: { get: async () => ({}) } } as never);
    const relay = new Relay(host, []);
    try {
      await new PaseoTelegramRuntime(host, relay, bot.id).start("agent-1", "Plan a trip", "telegram:42:1");
      expect(created).toMatchObject({ agentId: "agent-1", clientMessageId: "telegram:42:1", prompt: "Plan a trip", labels: { [BOT_LABEL]: "voyager", [TELEGRAM_LABEL]: "true" } });
      expect(created.config.systemPrompt).toContain("Use TREK for travel plans.");
    } finally { relay.stop(); }
  });

  it("checks bot ownership and uses the SDK's messageId option for subsequent prompts", async () => {
    const host = fakeHost([makeBot({ id: "voyager" })]); const sent: unknown[] = [];
    let labels = { [BOT_LABEL]: "voyager", [TELEGRAM_LABEL]: "true" };
    host.attach({ agents: { ref: () => ({ refresh: async () => ({ agent: { labels, archivedAt: null, status: "idle", requiresAttention: true, pendingPermissions: [] } }), send: async (...args: unknown[]) => { sent.push(args); }, timeline: { refetch: async () => ({ entries: [{ item: { type: "user_message", text: "Hi", clientMessageId: "telegram:42:1" } }, { item: { type: "assistant_message", text: "Hello" } }] }) } }) } } as never);
    const runtime = new PaseoTelegramRuntime(host, {} as never, "voyager");
    await runtime.send("agent-1", "next", "telegram:42:2");
    expect(sent).toEqual([["next", { messageId: "telegram:42:2" }]]);
    expect(await runtime.inspect("agent-1")).toEqual({ status: "idle", clientMessageId: "telegram:42:1", reply: "Hello", completionVerified: false });
    labels = { [BOT_LABEL]: "other", [TELEGRAM_LABEL]: "true" };
    await expect(runtime.send("agent-1", "secret", "telegram:42:3")).rejects.toThrow("configured bot");
    expect(sent).toHaveLength(1);
  });

  it("correlates only the latest user prompt and excludes older replies", () => {
    expect(telegramTurn([
      { type: "user_message", text: "old", clientMessageId: "old" },
      { type: "assistant_message", text: "old answer" },
      { type: "user_message", text: "new", clientMessageId: "telegram:42:2" },
      { type: "assistant_message", text: "first" },
      { type: "assistant_message", text: "second" },
    ] as never)).toEqual({ clientMessageId: "telegram:42:2", reply: "first\n\nsecond" });
  });
});
