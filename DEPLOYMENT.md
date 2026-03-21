# Deployment Guide (Wispbyte / Any Node.js Host)

## Setting Environment Variables

**Never put your bot token or IDs directly in the startup command.**  
Instead, set them as Environment Variables in your host's panel (e.g. Wispbyte → Server → Startup → Variables).

### Required Variables

| Variable | Description |
|---|---|
| `BOT_TOKEN` | Your Discord bot token (from [Discord Developer Portal](https://discord.com/developers/applications)) |
| `GUILD_ID` | The Discord server (guild) ID where the bot operates |
| `STAFF_ROLE_ID` | Comma-separated staff role IDs (e.g. `123456789,987654321`) |
| `FIND_A_TUTOR_CHANNEL_ID` | Channel ID for the find-a-tutor channel |
| `TUTORS_FEED_CHANNEL_ID` | Channel ID for the tutors feed channel |

### Optional Variables

| Variable | Description |
|---|---|
| `STAFF_CHAT_ID` | Channel ID for staff chat |
| `TICKET_CATEGORY_ID` | Category ID for ticket channels |
| `TRANSCRIPTS_CHANNEL_ID` | Channel ID for ticket transcripts (default: `1443015615957696603`) |
| `TUTOR_CHAT_CHANNEL_ID` | Channel ID for tutor chat |
| `TUTOR_POLICIES_CHANNEL_ID` | Channel ID for tutor policies |
| `MODMAIL_CATEGORY_ID` | Category ID for modmail threads |
| `MODMAIL_TRANSCRIPTS_CHANNEL_ID` | Channel ID for modmail transcripts |
| `BUMP_CHANNEL_ID` | Channel ID for bump tracking (if not set, listens in all channels) |
| `ADS_CHANNEL_ID` | Channel ID for ads |
| `ARCHIVED_ADS_CHANNEL_ID` | Channel ID for archived ads |
| `SYNC_SECRET` | Shared secret for the ad-sync webhook endpoint |
| `SYNC_WEBHOOK_URL` | Webhook URL for outbound ad sync |
| `SERVER_HOST` | Host address for the web server (optional) |

## Startup Command

Your Wispbyte startup command should be:

```
/usr/local/bin/node /home/container/index.js
```

All secrets/IDs are read from the environment variables you set in the panel — no `export` commands needed in the startup line.

## Understanding Startup Logs

When the bot starts successfully, you will see something like:

```
Logged in as TutorsLink#1234
Bot is in guild: TutorsLink Server (1360708397850431488)
```

### What the log lines mean

| Log message | Meaning |
|---|---|
| `Logged in as <tag>` | Bot connected to Discord successfully using the token |
| `Bot is in guild: <name> (<id>)` | Bot is a member of the configured guild — everything is working |
| `Bot is NOT in the configured guild` | Bot is not in the server. Re-invite it via the OAuth2 URL in the Developer Portal |
| `Missing required environment variable: <NAME>` | That env var is not set. Add it in Wispbyte's Variables panel and restart |

## Security Notes

- **Rotate your bot token** if it was ever posted publicly or in a chat log. Go to Discord Developer Portal → Applications → Your App → Bot → Reset Token.
- After rotating, update `BOT_TOKEN` in Wispbyte's Variables panel.
- Never share your token with anyone or embed it in source code.

## How to Find Your IDs

1. Enable **Developer Mode** in Discord: User Settings → Advanced → Developer Mode
2. Right-click a server/channel/role → **Copy ID**
