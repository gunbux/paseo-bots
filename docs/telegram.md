# Telegram channel

The optional Telegram listener runs inside the paseo-bots server plugin. Each
allowed private chat has a persistent agent in the configured bot's workspace.
It uses that bot's instructions, memory, skills, provider and tools. The bot's
configured preapproved tools still apply; Telegram does not auto-approve new
permission requests or saved shell-command rules. Review requests in Paseo.

## Configure

Create a dedicated bot with Telegram's @BotFather. Keep its token in a private
file readable by the daemon user, outside your repository and the Nix store.
Do not run another getUpdates consumer or a webhook against the same token.
The listener does not remove existing webhooks automatically.

Write `~/.config/paseo/telegram.json` on the daemon host, or set
`PASEO_BOTS_TELEGRAM_CONFIG` to another absolute config path:

```json
{
  "enabled": true,
  "botId": "your-local-bot-id",
  "allowedUserIds": ["123456789"],
  "allowedChatIds": ["123456789"],
  "tokenFile": "/run/secrets/paseo_telegram_bot_token",
  "bootstrapCommand": ["/absolute/path/to/paseo-bridge", "bots-hello"]
}
```

Private chat IDs are the corresponding user IDs. Usernames such as `@name`
cannot replace numeric IDs. Only text in explicitly allowed private chats is
accepted. Groups and channels are rejected even when someone mentions the bot.
Group support should use separate conversations and explicit mention/reply rules.

The file is optional; no file or `{"enabled":false}` disables the listener. Reload
the plugin after changing the file or token. Configure it on only the daemon
that owns the bot. Desktop-managed daemons stop listening when their daemon stops.

The Paseo SDK gives plugins its API inside handlers and lifecycle events. A
bootstrap command should invoke `paseo-bots` RPC `bots.hello` with `{}` through a
local authenticated client. The command is an argv array, never shell text. It
runs with the daemon environment, receives no Telegram token, and retries every
five seconds until the API attaches. The dotnix `paseo-bridge bots-hello` command
implements this. Without a bootstrap command, open the Bots screen once after
each daemon restart to attach the API.

## Identify your private chat

Before enabling the listener, send `/start` to your new bot. The setup helper
accepts a token on stdin and prints only matching private chat/user IDs:

```sh
sops --decrypt --extract '["paseo_telegram_bot_token"]' secrets/secrets.yaml \
  | node /path/to/paseo-bots/server/telegram/identify.mjs chunyulam
```

Run the helper while the listener is disabled. It refuses an existing webhook.
It consumes updates while identifying your chat, so do not use it alongside a
running bot. The username argument identifies the sender, not the bot.

## Commands and recovery

- `/start` and `/help` describe the channel.
- `/new` makes the next message create a fresh thread. Stop a busy turn first.
- `/stop` interrupts this Telegram thread and clears its queued prompts.

Replies appear in both Paseo and Telegram. Tool requests produce a Telegram
notice; open Paseo to approve or deny them. Messages queue while the agent works.
Replies over Telegram's limit split into ordered plain-text messages.

The listener saves its inbox, outbox, Telegram update offset and chat-to-agent
mapping in `$PASEO_HOME/plugin-data/paseo-bots/telegram-state.json`, with mode
0600. The token is never stored there. Fix storage errors and reload the plugin
before continuing; a failed state write prevents further update acknowledgments.

After a restart, the listener resumes mapped conversations and recovers output
by the prompt's client message ID. Paseo's snapshot does not retain a reliable
completed/canceled outcome, so recovered output is labeled as unverified and
may be partial. An ambiguous dispatch blocks that chat instead of replaying
potential side effects. Inspect the thread in Paseo and use `/new` to recover.

Telegram delivery is at least once. A crash after Telegram accepts a reply but
before the listener saves that acknowledgment can duplicate the reply. Changing
`botId` requires moving the old state file aside while the listener is stopped.
Removing an ID from the allowlist also stops delivery to its stored chat.

## Verify

Run `npm test` and `npm run typecheck`. Some tests bind local HTTP listeners and
need an environment that permits them. After loading the plugin on your daemon,
check `paseo plugin ls paseo-bots` and `paseo plugin logs paseo-bots`.

Send two messages to the bot and confirm they appear in the same Voyager thread.
Reload the plugin and send another message; it must resume the same thread. Check
`/stop`, `/new` and a permission request. A different Telegram account and every
group chat must be ignored. Token rotation needs a plugin reload.
