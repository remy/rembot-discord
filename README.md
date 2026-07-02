# rembot

A Discord moderation bot that guards against cross-channel spam raids. When the **same user posts
the same message across several channels within a short window**, rembot **bans them** and
**purges their recent messages** (last hour by default) — all in a single ban call.

## How it works

- Watches `messageCreate` events across the server (or a chosen subset of channels).
- Keeps a short in-memory, per-user history of recent messages.
- If the same normalised message appears in **≥ `DUP_CHANNEL_THRESHOLD` distinct channels** within
  **`WINDOW_MS`**, it fires.
- Enforcement uses Discord's ban endpoint with `deleteMessageSeconds`, which bans the user **and**
  deletes all of their messages guild-wide from the last `DELETE_SECONDS` in one call.

No database — the sliding window lives in memory. A restart just resets the window, which is fine
for this abuse pattern.

### Enforcement action (`ACTION`)

- **`ban`** (default) — permanently bans and purges the last `DELETE_SECONDS` of their messages.
- **`softban`** — bans *then immediately unbans*. Because Discord's kick API can't delete
  messages, this is the standard way to **kick + purge**: the user is removed and their recent
  messages are wiped, but they're not on the ban list and can rejoin with a fresh invite.
- **`kick`** — kick only; **messages are left in place** (Discord provides no message deletion on
  kick). Needs the **Kick Members** permission instead of Ban Members.

`ban` and `softban` both use the **Ban Members** permission you already grant, so switching to
`softban` needs no permission changes.

## 1. Create the bot in the Developer Portal

1. Go to <https://discord.com/developers/applications> → **New Application**.
2. **Bot** tab → **Reset Token** → copy the token into your `.env` as `DISCORD_TOKEN`.
3. **Bot** tab → **Privileged Gateway Intents** → enable **Message Content Intent**.
   > Without this, the bot receives empty message text and can never detect duplicates.
4. Invite the bot: **OAuth2 → URL Generator**, scopes **`bot`** *and* **`applications.commands`**
   (the second is required for the `/history` slash command). Tick just these permissions:
   - **View Channels** — required, or the bot receives no messages.
   - **Ban Members** — required; its `deleteMessageSeconds` option also does the message purge.
   - **Send Messages** + **Embed Links** — only if you set `MOD_LOG_CHANNEL_ID` (to post reports).

   Leave everything else unchecked — in particular **Manage Messages is not needed** (the ban does
   the deletion), and never grant **Administrator**. Open the generated URL and add it to your server.
5. **Important:** in **Server Settings → Roles**, drag the bot's role **above** the roles of any
   users it might ban. Discord refuses a ban if the target's highest role is above the bot's.

## 2. Configure

```bash
cp .env.example .env
# then edit .env — at minimum set DISCORD_TOKEN
```

| Var | Default | Purpose |
|---|---|---|
| `DISCORD_TOKEN` | — | Bot token (required) |
| `DUP_CHANNEL_THRESHOLD` | `2` | Distinct channels that trip it |
| `WINDOW_MS` | `30000` | Detection window (30s) |
| `MIN_MESSAGE_LENGTH` | `8` | Ignore very short messages |
| `ACTION` | `ban` | `ban`, `softban` (kick + purge), or `kick` (no purge) |
| `DELETE_SECONDS` | `3600` | Message-purge lookback (1h, max 604800) |
| `DRY_RUN` | `false` | Log only, don't ban — use for first test |
| `MONITORED_CHANNEL_IDS` | empty = all | Only watch these channels |
| `IGNORED_CHANNEL_IDS` | empty | Never watch these channels |
| `IMMUNE_ROLE_ID` | empty | A role that is never actioned |
| `MOD_LOG_CHANNEL_ID` | empty | Post action reports here |
| `DATA_DIR` | `./data` | Where the persistent ban log lives |

> Admins, the server owner, bots, and anyone with **Ban Members** are always immune, regardless of
> `IMMUNE_ROLE_ID`.

## 3. Run locally (test first)

```bash
npm install
npm start
```

Recommended first test with `DRY_RUN=true`:

1. From a second (alt) account, post the same text (≥ 8 chars) in two channels within 30s.
2. The console (and mod-log channel, if set) shows **"DRY RUN — would ban"**, no action taken.
3. Set `DRY_RUN=false` and repeat → the alt is banned and its last-hour messages disappear.

## 4. Deploy on your NAS (Docker)

With Docker / Container Manager available:

```bash
docker compose up -d          # build + start, auto-restarts on reboot/crash
docker compose logs -f        # watch it connect
```

- On **Synology**, either use **Container Manager → Project** pointed at this folder, or run the
  compose command over SSH.
- Keep `.env` next to `docker-compose.yml`; it is loaded via `env_file` and is gitignored.
- No ports are exposed — the bot only makes an outbound gateway connection.

To update after code changes: `docker compose up -d --build`.

## History (`/history`)

Every action rembot takes (real bans and dry-run matches) is appended to a persistent log at
`DATA_DIR/bans.json`, which survives restarts (stored in the `rembot-data` Docker volume).

Run **`/history`** in Discord to see recent actions. Options:

- `limit` — how many to show (default 20, max 50).
- Only members with **Ban Members** can use it, and the reply is **ephemeral** (only you see it).
- Users are listed as **plain text** with their ID — never as `@mentions`, so listing history
  never pings the offenders.

Example reply:

```
rembot — last 2 of 2 action(s)
• spammer#0 (id 123456789) — 2026-07-01 14:22 UTC — 3 ch
• raider (id 987654321) — 2026-07-01 09:05 UTC — 2 ch (dry-run)
```

> Slash commands are registered per-guild on startup (instant). If `/history` doesn't appear,
> re-invite the bot including the **`applications.commands`** scope (see step 4).

## Notes

- `deleteMessageSeconds` purges the banned user's messages **everywhere** in the guild for the
  lookback window, not only the channels that tripped detection — which is what you want for a
  raider.
- A future phase could add slash commands to tune thresholds live, an allow-list, or stats; this
  build keeps to the core auto-moderation.
