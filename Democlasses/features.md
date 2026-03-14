# Demo Classes — Feature Overview

This document describes all features of the demo classes module, implemented across `demo.js`, `webserver.js`, and integrated into `index.js`.

---

## Slash Commands

### `/startdemo`
Starts a demo recording session for a student.

- **Parameters:** `student` (required user mention), `title` (required string)
- **Access:** Staff members or the tutor assigned to the specified student
- Creates a **private temporary voice channel** that only the student, tutor (if assigned), staff roles, and the bot can see and join
- Confirms creation with a link to the new channel
- Recording begins automatically once both the student and tutor are present in the channel
- Registered and skipped by `index.js`; handled exclusively by `demo.js`

### `/authentication`
Generates a short-lived authentication token for accessing the web dashboard.

- **Access:** Staff only
- Produces a one-time token valid for **2 minutes**
- Returns the raw token and a direct link to the webapp pre-populated with the token
- Token is stored as a SHA-256 hash (the raw token is never persisted)
- Registered and skipped by `index.js`; handled exclusively by `demo.js`

---

## Voice Recording

### Multi-track Opus capture
Each speaking user in the session is recorded to their own separate `.raw` file (Craig-style recording).

- Uses `@discordjs/voice` to subscribe to each user's Opus audio stream
- Each frame is stored in a custom binary format: `[2-byte frame length][Opus packet][8-byte timestamp]`
- Users who join after the session starts are subscribed automatically
- Users who leave mid-session are unsubscribed and their file is finalised

### Automatic recording start
Recording starts automatically (no manual trigger needed) when **both the student and the tutor** are detected in the voice channel.

- Waits 2 seconds after both join before starting to allow connections to stabilise
- Confirms the voice connection is in the `Ready` state (up to 15-second timeout) before proceeding

### Announcement audio
When recording begins, the bot plays `announcement.wav` into the voice channel to notify participants that the session is being recorded.

- Playback has a 10-second maximum timeout
- Recording subscriptions are opened *before* the announcement plays so no early speech is lost

### Automatic recording stop
Recording stops and is finalised when **both the student and tutor have left** the channel.

- Also triggered by an unexpected voice connection disconnection

### Per-user file validation
After all streams are closed:
- Files smaller than 1 KB are flagged as invalid and staff are alerted
- Each raw dump file is validated for correct binary structure (frame length + Opus header)
- A 500 ms flush delay ensures buffers are written to disk before validation

---

## Temporary Voice Channels

- A new private voice channel is created for each demo session (name format: `demo-<timestamp suffix>`)
- **Permission overwrites:**
  - `@everyone` — denied View Channel and Connect
  - Bot — allowed View Channel, Connect, Manage Channels
  - Student — allowed View Channel and Connect
  - Tutor (if assigned) — allowed View Channel and Connect
  - All configured staff roles — allowed View Channel and Connect
- The channel is deleted automatically when the recording is finalised or cleaned up

---

## Access Control

- `/startdemo` checks that the invoker is either a staff member or the tutor assigned to the specified student (looked up from `db.studentAssignments`)
- `/authentication` is restricted to staff members only
- Staff role IDs are read from the `STAFF_ROLE_ID` environment variable; multiple roles can be specified as a comma-separated list

---

## Web Dashboard (`webserver.js`)

An HTTP server (default port **9281**) provides staff with browser-based access to recordings.

### Authentication
- `POST /api/auth` — Verify a token; returns `200 OK` on success or `401` on failure
- Tokens are short-lived (2 minutes) and stored as SHA-256 hashes
- Rate limiting is applied to auth endpoints (10 requests per 60-second window per IP)

### Discord OAuth2 login
- `GET /api/discord-auth` — Returns a Discord OAuth2 authorisation URL
- Discord OAuth2 callback mints a short-lived session token and redirects to the webapp

### Recording API (all endpoints require a valid Bearer token or `?token=` query parameter)
- `GET /api/recordings` — List all recordings (id, title, tutorId, studentId, createdAt)
- `GET /api/recordings/:id` — Get full details for a recording, including a list of audio file download URLs
- `GET /api/recordings/:id/audio/:filename` — Stream or download an individual audio file
- `DELETE /api/recordings/:id` — Delete a recording; requires the correct **delete key** in the request body

### Recording page
- `GET /recording/:id` — Serves the HTML recording viewer page

---

## Metadata & Persistence

- Recording metadata is stored in `./recordings/metadata.json`
- Each entry contains: `recordingId`, `title`, `tutorId`, `studentId`, `createdAt`, `filePath`, `deleteKey`, `userIds`
- Audio files are stored under `./recordings/<recordingId>/`
- The **delete key** is a cryptographically random string (two UUIDs concatenated) required to delete a recording via the API

---

## Staff Notifications

### New recording notification
When a recording is finalised, the bot sends a rich embed to the staff channel (`STAFF_CHAT_ID`) containing:
- Recording title and ID
- Student and tutor mentions
- A link to view the recording in the web dashboard
- The delete key (spoiler-tagged)

### Error notifications
Any error in the demo module is reported to the staff channel with:
- Staff role mentions
- Module name and recording ID
- Full error stack trace (truncated to 1 900 characters)

### Deletion warning
Staff are warned **24 hours before** a recording is automatically deleted via an embed listing the affected recordings.

---

## Automatic Cleanup

- Recordings older than **7 days** are deleted automatically (files + metadata)
- Staff are sent a warning embed for recordings that will be deleted within 24 hours (sent once per recording)
- Cleanup runs on bot startup and then **every hour**

---

## Integration with `index.js`

- `initDemo(client)` is called during bot startup, after `initModmail`
- The main database (`db`) is shared with the demo module via `global.demoDB`, enabling student-assignment lookups
- `/startdemo` and `/authentication` are registered as slash commands by `index.js`'s `registerCommands()` function
- `index.js` detects these two commands and immediately returns, leaving `demo.js` as the sole handler

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GUILD_ID` | ✅ | Discord server ID |
| `STAFF_ROLE_ID` | ✅ | Comma-separated staff role IDs |
| `STAFF_CHAT_ID` | ✅ | Channel ID for staff notifications |
| `SERVER_HOST` | ❌ | Hostname (with or without protocol) used to build webapp URLs; defaults to `localhost:9281` |
| `DISCORD_CLIENT_ID` | ❌ | Discord application client ID for OAuth2 login |
| `DISCORD_CLIENT_SECRET` | ❌ | Discord application client secret for OAuth2 login |
