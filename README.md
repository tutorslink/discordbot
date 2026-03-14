# Isofusie — Discord Tutoring Platform Bot

Isofusie is a feature-rich Discord bot built for managing a tutoring community server. It provides a complete workflow for matching students with tutors, handling enquiries, managing tutor advertisements, collecting reviews, recording voice sessions, and running a modmail support system.

---

## Features

### 🎓 Enquiry & Ticket System
- Students create enquiry tickets for a chosen subject via `/enquire`
- Tickets are opened inside a dedicated category with a customisable initial message
- Staff reply to tickets with `/reply <code> <message>`
- Staff close tickets with `/close <code>`, specifying a reason and assigning a tutor
- Closed tickets generate a transcript posted to a configurable transcripts channel
- A review reminder is automatically sent to the student after a configurable delay

### 📬 Modmail System
- Students initiate modmail sessions by sending a DM to the bot
- Supports four ticket categories selectable via drop-down:
  - **A** — Tutor Application
  - **C** — Complaints & Suggestions
  - **S** — Customer Service
  - **P** — Payment
- Each category maintains its own independent ticket counter
- 120-second per-user cooldown per category prevents spam
- Staff messages are forwarded into the ticket channel; student messages are forwarded back to the user's DM
- Reaction feedback (✅ / ❌) confirms whether forwarding succeeded
- Closing a ticket triggers a modal to collect a closure reason and posts a full transcript

### 📢 Tutor Advertisement Management
- Create rich-embed tutor ads with `/createad` (modal-based: subject, description, colour, level, tutor)
- Edit existing ads with `/editad <messageId>` (modal pre-filled with current values)
- Delete and archive ads with `/deletead <messageId> <reason>`
- Ads are automatically organised into level-based category channels:
  - IGCSE Tutors, AS/A Level Tutors, Below IGCSE Tutors, University Tutors, Language Tutors, Test Prep Tutors, Other Tutors
- Migrate existing ads to category channels with `/migrateads`
- "Talk to a tutor" button on each ad opens an enquiry ticket pre-filled with the relevant subject

### ⭐ Review System
- Students receive a review prompt with a direct link after a ticket closes
- Reviews are submitted via a modal (rating + written feedback)
- Submitted reviews enter a pending queue for staff approval
- Staff approve reviews with a button; approved reviews appear in the tutor's profile embed
- Staff can redact individual reviews if needed
- Tutor profile embeds show average rating and all approved reviews

### 👩‍🏫 Tutor Management
- Add or remove tutors with `/tutor add|remove <user>`
- Assign subjects to tutors and list tutor subjects with `/tutor subject`
- View a tutor's full profile (subjects, students, reviews, notes) with `/tutor info`
- Add internal notes to a tutor's record with `/tutor notes`
- Edit tutor profile fields (phone number, date of birth) with `/tutoredit`

### 📚 Subject Management
- Add, remove, and list subjects with `/subject add|remove|list`
- Link subjects to academic levels (IGCSE, A Level, Below IGCSE, University, Language, Test Prep, Other)
- Assign a default tutor to a subject with `/subject tutor-assigned`
- Seed a standard set of IGCSE / AS / A Level subjects with `/seedsubjects`

### 🧑‍🎓 Student Assignment
- Assign students to a tutor for a specific subject with `/student add`
- Remove student assignments with `/student remove`
- Student assignment data is stored per tutor and visible in their profile

### 🎙️ Voice Recording (Demo Sessions)
- Start a multi-track voice recording session with `/startdemo <student> <title>`
- Each participant's audio is captured to a separate `.opus` file in real time
- Recording metadata (ID, tutor, student, participants, timestamp) is stored in `recordings/metadata.json`
- Recordings are accessible through the authenticated web interface

### 🌐 Web Dashboard
- Express-based web server running on port **9904**
- Generate a short-lived authentication code (2-minute expiry, SHA-256 hashed) with `/authentication`
- Alternatively authenticate via Discord OAuth2
- Authenticated users can list, stream, and download individual audio tracks
- Rate-limited to 10 requests per minute per IP
- Directory-traversal protection on all file-serving endpoints
- Recordings can be deleted via the dashboard using a delete key

### 🏆 Bump Leaderboard
- Automatically tracks DISBOARD bump interactions
- Displays a ranked leaderboard via `/bumpleaderboard`
- Optionally restricted to a configured bump channel

### 🛠️ Admin & Utility Commands
- `/sticky` — Create or edit a sticky welcome/info message in a channel (modal-based)
- `/embedcolor <hex>` — Set the default embed accent colour for the bot
- `/editinit` — Edit the initial message shown when a ticket is opened (modal-based)
- `/reviewreminder <seconds>` — Configure the delay before a review prompt is sent after ticket closure
- `/exportchannels` — Export all guild categories and channels as a JSON snapshot
- `/staffhelp` — Display the full list of staff-only commands
- `/help` — Display user-facing commands

---

## Tech Stack

- **[discord.js](https://discord.js.org/) v14** — Core Discord API library
- **[@discordjs/voice](https://github.com/discordjs/discord.js/tree/main/packages/voice)** — Voice channel connection & audio capture
- **[Express](https://expressjs.com/) v5** — Web server and REST API
- **[dotenv](https://github.com/motdotla/dotenv)** — Environment variable loading
- **[ffmpeg-static](https://github.com/eugeneware/ffmpeg-static)** — Bundled FFmpeg binaries for audio processing

---

## Requirements

- Node.js 18 or later (Node.js 20 LTS recommended; required by `dotenv` v17 and `discord.js` v14)
- A Discord application & bot token ([Discord Developer Portal](https://discord.com/developers/applications))
- The bot must be invited to the server with the required intents and slash-command permissions

---

## Installation

```bash
# 1. Clone the repository
git clone <repository-url>
cd isofusie

# 2. Install dependencies
npm install

# 3. Create a .env file (see Configuration section below)

# 4. Start the bot
node index.js
```

---

## Configuration

Create a `.env` file in the project root. Required variables are marked with ✱.

| Variable | Required | Description |
|---|---|---|
| `BOT_TOKEN` | ✱ | Discord bot token |
| `GUILD_ID` | ✱ | Discord server (guild) ID |
| `STAFF_ROLE_ID` | ✱ | Staff role ID(s); comma-separated for multiple roles |
| `FIND_A_TUTOR_CHANNEL_ID` | ✱ | Channel where tutor ads are posted |
| `TUTORS_FEED_CHANNEL_ID` | ✱ | Channel for tutor feed announcements |
| `STAFF_CHAT_ID` | | Channel for staff notifications and bot error reports |
| `TICKET_CATEGORY_ID` | | Category for enquiry ticket channels |
| `TRANSCRIPTS_CHANNEL_ID` | | Channel where ticket transcripts are posted |
| `TUTOR_CHAT_CHANNEL_ID` | | Channel for internal tutor discussions |
| `TUTOR_POLICIES_CHANNEL_ID` | | Channel for tutor policy documents |
| `MODMAIL_CATEGORY_ID` | | Category for modmail channels |
| `MODMAIL_TRANSCRIPTS_CHANNEL_ID` | | Channel for modmail transcripts |
| `BUMP_CHANNEL_ID` | | Channel to restrict bump tracking (all channels if omitted) |
| `ADS_CHANNEL_ID` | | Channel for ad archive posts |
| `ARCHIVED_ADS_CHANNEL_ID` | | Channel for archived/deleted ads |
| `DISCORD_CLIENT_ID` | | Discord OAuth2 client ID (for web dashboard login) |
| `DISCORD_CLIENT_SECRET` | | Discord OAuth2 client secret |
| `DISCORD_REDIRECT_URI` | | OAuth2 redirect URI (auto-detected if omitted) |
| `SERVER_HOST` | | Hostname or IP for the web dashboard (used in recording links) |
| `SYNC_SECRET` | | Shared secret for external webhook sync |
| `SYNC_WEBHOOK_URL` | | External webhook URL to sync data to |

---

## Data Storage

All persistent data is stored locally in **`data.json`**, including:

- Subject and subject-level mappings
- Tutor profiles, assigned subjects, and notes
- Student-tutor assignments
- Ticket records and transcript metadata
- Pending and approved reviews
- Tutor ad content and archived ads
- Bump leaderboard counts
- Modmail ticket records and per-category counters
- Bot configuration (embed colour, initial message, review reminder delay)

---

## Voice Recordings Storage

- Recordings are saved under `./recordings/<recordingId>/`
- Each participant's audio is stored as `<userId>.opus`
- Global metadata is stored in `./recordings/metadata.json`
