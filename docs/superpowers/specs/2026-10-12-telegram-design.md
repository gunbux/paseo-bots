# Telegram for Voyager

Approved in the conversation on 2026-10-12. Run a text-only Telegram channel
inside paseo-bots on legion-nix. Bind a BotFather token to Voyager's fixed bot
ID and allow only explicitly configured private chat and user IDs. Each chat
maps to one persistent Paseo agent, visible in Voyager's workspace and created
with the same instructions, MCP servers, memory and app tools as other bot chats.

Use long polling, a durable inbox and an outbox under the plugin data directory.
Save updates before advancing Telegram's offset. Dispatch one message at a time
per chat. Persist the agent ID before starting its first turn. Do not replay an
ambiguous in-flight prompt after restart. Recover its reply using the timeline
and client message ID, or ask the user to inspect Paseo. Outbound delivery retries
may duplicate a Telegram message if the process dies after Telegram accepts it.

Support /start, /help, /new and /stop. /new must not orphan a running turn.
Permissions require action in Paseo and produce a Telegram notice. Never grant
permissions automatically. Relay only completed replies to dispatched Telegram
messages, not arbitrary turns started in the UI.

Read the token from a file outside the Nix store; never include it in prompts,
logs or subprocess arguments. Keep the config absent/disabled until credentials
and allowed IDs exist. Use the existing version-matched paseo-bridge executable
to invoke bots.hello after startup because the SDK only gives plugins a Paseo API
inside handlers and lifecycle events. Retry bootstrap without launching an agent.

At the user's subsequent request, publish the tested branch to a gunbux/paseo-bots
fork and pin that exact commit through dotnix. Add a disabled
NixOS option for legion-nix that provisions the SOPS secret and channel config
when enabled. Do not activate NixOS or restart the user's daemon in this task.
