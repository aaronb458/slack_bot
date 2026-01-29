# Slack Project Tracker Bot

A silent Slack bot that sits in every channel, tracks all messages, threads, and tasks — and lets authorized users privately ask it questions via DM, powered by Claude AI.

**The team and clients never see it do anything.** It just watches. You DM it to get insights.

---

## What This Bot Does

```
 YOUR SLACK WORKSPACE                    YOU (private DM)
┌──────────────────────┐                 ┌─────────────────────────────────┐
│ #project-alpha       │──┐              │ You: "what's going on?"         │
│ #project-beta        │──┤              │                                 │
│ #client-work         │──┤  silently    │ Bot: "Here's your update..."    │
│ #marketing           │──┼──tracks──    │  • 3 open tasks in #alpha      │
│ #design              │──┤  everything  │  • Jake hasn't posted in 5 days│
│ (every channel)      │──┘              │  • Blocked: waiting on copy    │
└──────────────────────┘                 └─────────────────────────────────┘
 Bot NEVER talks here.                    Only YOU see this.
 Totally invisible.                       Powered by Claude AI.
```

### It Tracks (automatically, 24/7):
- Every message in every channel
- Every thread reply
- Who is in each channel (joins/leaves)
- Emoji reactions (used for task status)
- Tasks — auto-detected from messages like "TODO:", "@person please do X", "need to...", "blocked by..."
- Activity per person — message counts, engagement, which channels they're in

### It Does NOT:
- Never posts in any channel — invisible to everyone
- Never stores DMs between people — only channel messages
- Never shares data outside authorized users
- Costs $0 for tracking. Only costs ~$0.01-0.03 per question you ask it (Claude AI)

---

## How You Talk To It

Open a DM with the bot in Slack and just type naturally:

| You type | What it does |
|---|---|
| "what's going on?" | Global summary of all projects |
| "tell me about project alpha" | Members, tasks, activity for that channel |
| "what tasks are open?" | All open tasks across everything |
| "what's Jake working on?" | Jake's tasks, channels, message count |
| "anything blocked?" | All blocked/stalled tasks |
| "search for landing page" | Searches all messages everywhere |
| "who's most active in #marketing?" | Activity breakdown |
| "reset" | Clears conversation memory |

It remembers context — you can ask follow-up questions.

---

# SETUP GUIDE

**Read this carefully. Follow every step in order. Do not skip anything.**

You need 4 things:
1. A Slack App (you create it in Slack's website)
2. An Anthropic API key (for the AI)
3. This code (from GitHub)
4. A Railway account (to host it 24/7)

---

## STEP 1: Create the Slack App

1. Go to **https://api.slack.com/apps**
2. Log in with the Slack workspace you want the bot in
3. Click the green **"Create New App"** button
4. Click **"From scratch"**
5. Name it: `Project Tracker` (or whatever you want)
6. Pick your workspace from the dropdown
7. Click **"Create App"**

You're now on the app's settings page. **Don't close this tab** — you'll be here for steps 2-6.

---

## STEP 2: Turn On Socket Mode

1. In the left sidebar, click **"Socket Mode"**
2. Toggle it **ON**
3. It asks for a token name — type `socket`
4. It asks for scopes — add `connections:write`
5. Click **"Generate"**
6. **COPY THE TOKEN** that starts with `xapp-...` — paste it somewhere safe (Notepad, Notes app, whatever)
7. Click **"Done"**

---

## STEP 3: Add Bot Permissions (Scopes)

1. In the left sidebar, click **"OAuth & Permissions"**
2. Scroll down to the section called **"Bot Token Scopes"**
3. Click **"Add an OAuth Scope"** and add **ALL** of these (one at a time):

```
channels:read
channels:history
channels:join
groups:read
groups:history
chat:write
commands
reactions:read
users:read
im:history
im:read
im:write
```

That's 12 scopes total. Make sure you got all 12.

---

## STEP 4: Turn On App Home (IMPORTANT — easy to miss)

1. In the left sidebar, click **"App Home"**
2. Scroll down to **"Show Tabs"**
3. Make sure **"Messages Tab"** is toggled **ON**
4. Check the checkbox: **"Allow users to send Slash commands and messages from the messages tab"**

**If you skip this step, DMs to the bot will not work. This is the #1 setup mistake.**

---

## STEP 5: Subscribe to Events

1. In the left sidebar, click **"Event Subscriptions"**
2. Toggle **"Enable Events"** to **ON**
3. Scroll down to **"Subscribe to bot events"**
4. Click **"Add Bot User Event"** and add **ALL** of these:

```
message.channels
message.groups
message.im
reaction_added
reaction_removed
channel_created
member_joined_channel
member_left_channel
channel_rename
```

That's 9 events total.

5. Click **"Save Changes"** at the bottom

---

## STEP 6: Create Slash Commands

1. In the left sidebar, click **"Slash Commands"**
2. For each command below, click **"Create New Command"**, fill in the fields, and save:

**Command 1:**
- Command: `/tasks`
- Request URL: `https://localhost/slack/events`
- Short Description: `List tasks`
- Usage Hint: `[all|open|done|mine|@user]`

**Command 2:**
- Command: `/task`
- Request URL: `https://localhost/slack/events`
- Short Description: `Manage a task`
- Usage Hint: `add|done|progress|assign`

**Command 3:**
- Command: `/project`
- Request URL: `https://localhost/slack/events`
- Short Description: `Project report for this channel`

**Command 4:**
- Command: `/summary`
- Request URL: `https://localhost/slack/events`
- Short Description: `Global project summary`

**Command 5:**
- Command: `/whois`
- Request URL: `https://localhost/slack/events`
- Short Description: `User activity summary`
- Usage Hint: `@user`

**Command 6:**
- Command: `/ping`
- Request URL: `https://localhost/slack/events`
- Short Description: `Check if bot is running`

The Request URL doesn't matter because Socket Mode bypasses it. But Slack requires something there, so just use `https://localhost/slack/events`.

---

## STEP 7: Install the App to Your Workspace

1. In the left sidebar, click **"Install App"**
2. Click **"Install to Workspace"**
3. Click **"Allow"**
4. **COPY** the **"Bot User OAuth Token"** — starts with `xoxb-...` — save it
5. Now go to **"Basic Information"** in the left sidebar
6. Scroll to **"App Credentials"**
7. **COPY** the **"Signing Secret"** — save it

---

## STEP 8: Get an Anthropic API Key

1. Go to **https://console.anthropic.com/**
2. Create an account (or log in)
3. Go to **"API Keys"** in the sidebar
4. Click **"Create Key"**
5. **COPY** the key — starts with `sk-ant-...` — save it
6. Go to **"Billing"** and add at least **$10** in credits (this will last months)

---

## STEP 9: Get Your Slack User ID

This tells the bot who's allowed to DM it.

1. Open Slack
2. Click your own profile picture
3. Click **"Profile"**
4. Click the **three dots** (**⋮**) menu
5. Click **"Copy member ID"**
6. It looks like `U01ABC123XY` — save it

If multiple people need access, get each person's member ID.

---

## STEP 10: Deploy on Railway

### 10a. Get the Code

Aaron will give you access to the GitHub repo. Once you have access:

```bash
git clone https://github.com/aaronb458/slack_bot.git
cd slack_bot
```

### 10b. Create a Railway Project

1. Go to **https://railway.app/** and sign up (GitHub login is easiest)
2. Click **"New Project"**
3. Click **"Deploy from GitHub Repo"**
4. Select the `slack_bot` repo
5. Railway will detect it's a Node.js app and start building

### 10c. Add Environment Variables

1. In Railway, click on your service (the box that appeared)
2. Go to the **"Variables"** tab
3. Click **"Add Variable"** for each:

| Variable | Value |
|---|---|
| `SLACK_BOT_TOKEN` | `xoxb-...` (from Step 7) |
| `SLACK_SIGNING_SECRET` | The signing secret (from Step 7) |
| `SLACK_APP_TOKEN` | `xapp-...` (from Step 2) |
| `ANTHROPIC_API_KEY` | `sk-ant-...` (from Step 8) |
| `CLAUDE_MODEL` | `claude-sonnet-4-5-20250929` |
| `AUTHORIZED_USERS` | `U01ABC123XY` (from Step 9, comma-separated if multiple) |

### 10d. Add a Persistent Volume (CRITICAL)

This is where the bot stores its database. Without this, data resets on every deploy.

1. In Railway, click on your service
2. Go to the **"Settings"** tab (or right-click the service → "Add Volume")
3. Click **"Add Volume"** (or find the Mounts/Volumes section)
4. Mount path: `/app/data`
5. Give it a name like `bot-data`
6. Save

### 10e. Deploy

Railway auto-deploys when you push to GitHub. After adding variables and the volume:

1. Go to the **"Deployments"** tab
2. Click **"Redeploy"** (or it may auto-trigger)
3. Watch the logs — you should see:

```
[INFO] [startup] Slack Project Tracker Bot is running!
[INFO] [startup] Syncing users...
[INFO] [startup] Synced 47 users
[INFO] [startup] Found 23 channels
[INFO] [backfill] #general done — 8 members, 156 messages, 12 threads
...
[INFO] [startup] Bot is fully operational.
```

If you see errors, check:
- All 6 environment variables are set correctly
- The volume is mounted at `/app/data`
- The Slack app has all 12 scopes and 9 events

---

## STEP 11: Test It

1. Open Slack
2. In the left sidebar under **"Apps"**, find your bot (or search for its name)
3. Click it to open a DM
4. Type: `hello`
5. Wait a few seconds — it should respond

Then try: `what's going on?`

If it responds with project data, **everything is working**.

---

## STEP 12: Add to Private Channels

The bot auto-joins all public channels on its own. For private channels:

1. Go to the private channel
2. Type `/invite @Project Tracker` (or whatever you named it)
3. Bot joins and immediately backfills all history

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Bot doesn't respond to DMs | Go to Slack App Settings → **App Home** → make sure Messages Tab is ON and the checkbox is checked |
| `missing_scope` error in logs | You missed a scope in Step 3 — add it in OAuth & Permissions and **reinstall the app** (Step 7) |
| `not_authed` or `invalid_auth` | Wrong token — double-check SLACK_BOT_TOKEN and SLACK_APP_TOKEN |
| `invalid x-]api-key` from Claude | Wrong ANTHROPIC_API_KEY — check it at console.anthropic.com |
| Bot crashes and restarts | Check Railway logs — the error message will tell you what's wrong |
| Data gone after redeploy | Volume not mounted — redo Step 10d |
| Bot doesn't join channels | Missing `channels:join` scope — add it and reinstall |
| No scheduled reports | `AUTHORIZED_USERS` not set — add your Slack user ID |

---

## Ongoing Cost

| Item | Cost |
|---|---|
| Railway hosting | ~$5/month |
| Claude AI (per question) | ~$0.01-0.03 |
| Slack | Free (bot uses no paid features) |
| **Total for normal use** | **~$10-15/month** |

---

## Tech Stack

| Component | Technology |
|---|---|
| Framework | Slack Bolt.js (Slack's official Node.js SDK) |
| Connection | Socket Mode (WebSocket — no public URL needed) |
| Database | SQLite (local file, zero config, stored on Railway volume) |
| AI | Claude Sonnet 4.5 via Anthropic API |
| Hosting | Railway (24/7 uptime, auto-deploy from GitHub) |
| Logging | File + console (viewable in Railway dashboard) |
