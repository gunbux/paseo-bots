export function splitMessage(text: string): string[] {
  const parts: string[] = [];
  while (text.length > 4096) {
    let end = 4096;
    if (/[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    parts.push(text.slice(0, end)); text = text.slice(end);
  }
  if (text) parts.push(text);
  return parts;
}

export class TelegramApiError extends Error {
  constructor(readonly status: number, readonly retryAfter = 5) { super(`Telegram API request failed (${status})`); }
}

export class TelegramTransport {
  private readonly lifetime = new AbortController();
  constructor(private readonly token: string, private readonly request: typeof fetch = fetch) {}
  stop(): void { this.lifetime.abort(); }

  private async call(method: string, body: object): Promise<unknown> {
    // Never propagate fetch errors: their cause or URL can contain the bot token.
    const controller = new AbortController();
    const cancel = () => controller.abort();
    this.lifetime.signal.addEventListener("abort", cancel, { once: true });
    if (this.lifetime.signal.aborted) cancel();
    const timeout = setTimeout(cancel, 35000);
    try {
      let response: Awaited<ReturnType<typeof fetch>>;
      try {
        response = await this.request(`https://api.telegram.org/bot${this.token}/${method}`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal,
        });
      } catch { throw new TelegramApiError(0); }
      let envelope: { ok?: boolean; result?: unknown; parameters?: { retry_after?: number }; error_code?: number };
      try { envelope = await response.json() as typeof envelope; } catch { throw new TelegramApiError(response.status); }
      if (!response.ok || !envelope.ok) throw new TelegramApiError(envelope.error_code ?? response.status, Math.min(3600, Math.max(1, envelope.parameters?.retry_after ?? 5)));
      return envelope.result;
    } finally { clearTimeout(timeout); this.lifetime.signal.removeEventListener("abort", cancel); }
  }

  async updates(offset: number): Promise<unknown[]> {
    const result = await this.call("getUpdates", { offset, timeout: 25, allowed_updates: ["message"], limit: 100 });
    if (!Array.isArray(result)) throw new TelegramApiError(0);
    return result;
  }
  async send(chatId: string, text: string): Promise<void> {
    await this.call("sendMessage", { chat_id: chatId, text, link_preview_options: { is_disabled: true } });
  }
}
