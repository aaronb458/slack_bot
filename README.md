# Slack Project Tracker Bot

A silent Slack bot that sits in every channel, tracks all messages, threads, and tasks — and lets you privately ask it questions via DM, powered by AI.

**The team and clients never see it do anything.** It just watches. You DM it to get insights.

**Cost:** ~$10-15/month total (Railway hosting + AI usage). Slack is free. Setup takes ~20 minutes.

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
 Totally invisible.                       Powered by AI.
```

### It Tracks (automatically, 24/7):
- Every message in every channel
- Every thread reply
- Who is in each channel (joins/leaves)
- Emoji reactions (used for task status)
- Tasks — auto-detected from messages like "TODO:", "@person please do X", "need to...", "blocked by..."
- Activity per person — message counts, engagement, which channels they're in

### Intelligence Features:
- **Morning Queue** — every weekday at 7am, DMs you a prioritized list of channels that need attention
- **Mood Detection** — detects frustrated, happy, or neutral clients based on their messages
- **Draft Messages** — suggests what to say, in your preferred tone (casual, professional, or friendly)
- **Priority Scoring** — ranks channels by urgency so you know what to tackle first
- **Cancellation Detection** — flags channels where a client mentions cancelling

### It Does NOT:
- Never posts in any channel — invisible to everyone
- Never stores DMs between people — only channel messages
- Never shares data outside authorized users

---

## How You Talk To It

Open a DM with the bot in Slack and just type naturally:

| You type | What it does |
|---|---|
| "what's going on?" | Prioritized queue of everything that needs attention |
| "tell me about project alpha" | Members, tasks, activity, mood for that channel |
| "how is the client feeling in #design?" | Mood analysis with draft response suggestion |
| "what tasks are open?" | All open tasks across everything |
| "what's Jake working on?" | Jake's tasks, channels, message count |
| "anything blocked?" | All blocked/stalled tasks |
| "search for landing page" | Searches all messages everywhere |
| "morning queue" | Same as the 7am auto-scan, on demand |
| "reset" | Clears conversation memory |

It remembers context — you can ask follow-up questions.

---

# SETUP GUIDE

**This guide walks you through everything, step by step. If you can follow a recipe, you can do this.**

### Before You Start — Make Sure You Have:

- **Admin access** to the Slack workspace where you want the bot (you need to be able to install apps). If you're not sure, ask whoever manages your Slack.
- **A web browser** and about 20-30 minutes of uninterrupted time.
- **A place to save tokens** as you go — a notes app, a text file, whatever. You'll collect 4-5 tokens/keys across the steps below and enter them all in Step 10.

### What You're Going to Set Up:

1. A Slack App (you create it in Slack's website — ~10 minutes)
2. An AI API key (the brain — ~2 minutes)
3. This code (from GitHub — ~1 minute)
4. A Railway account (to host it 24/7 — ~5 minutes)

**Total setup time: about 20-30 minutes.**

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

> **What you should have now:** One token starting with `xapp-...` saved somewhere safe.

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

> **These are optional.** The bot works perfectly fine through DMs without slash commands. But if you want quick shortcuts like `/scan` or `/tasks`, add them now. You can always come back and add these later.

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

**Command 7:**
- Command: `/scan`
- Request URL: `https://localhost/slack/events`
- Short Description: `Run morning scan on demand`

**Command 8:**
- Command: `/analyze`
- Request URL: `https://localhost/slack/events`
- Short Description: `Analyze current channel health`

**Command 9:**
- Command: `/team-ids`
- Request URL: `https://localhost/slack/events`
- Short Description: `List user IDs for team config`

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

> **What you should have now:** Three things saved:
> - `xapp-...` token (from Step 2)
> - `xoxb-...` token (from this step)
> - Signing Secret (from this step)

---

## STEP 8: Get an AI API Key

The bot uses AI to understand your questions and analyze your channels. **You need to pick a provider.**

### Option A: OpenRouter (RECOMMENDED)

OpenRouter lets you use AI models from many companies (Claude, GPT-4, Gemini, Llama, etc.) with one account. **This is the easiest option.**

1. Go to **https://openrouter.ai/**
2. Click **"Sign Up"** (Google login is fastest)
3. Go to **https://openrouter.ai/credits** and add **$5** in credits (this will last a long time)
4. Go to **https://openrouter.ai/keys**
5. Click **"Create Key"**
6. **COPY** the key — starts with `sk-or-...` — save it

> **What you should have now:** An OpenRouter API key starting with `sk-or-...`

### Option B: Anthropic (Claude only)

If you specifically want to use Claude directly (slightly cheaper, but locked to one provider):

1. Go to **https://console.anthropic.com/**
2. Create an account (or log in)
3. Go to **"API Keys"** in the sidebar
4. Click **"Create Key"**
5. **COPY** the key — starts with `sk-ant-...` — save it
6. Go to **"Billing"** and add at least **$5** in credits

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

### 10a. Get the Code on GitHub

1. If you haven't already, create a **GitHub** account at **https://github.com/** (it's free)
2. Come back to this repo page (you're probably reading this on it right now)
3. Near the top-right of the page, click the **"Fork"** button
4. Click **"Create fork"**

> **What "Fork" means:** It makes your own copy of this code under your GitHub account. You need your own copy so Railway can deploy it for you. The original stays untouched.

### 10b. Create a Railway Project

1. Go to **https://railway.app/** and sign up (GitHub login is easiest)
2. Click **"New Project"**
3. Click **"Deploy from GitHub Repo"**
4. Select the `slack_bot` repo (the fork you just made)
5. Railway will detect it's a Node.js app and start building

### 10c. Add Environment Variables

This is where all your saved tokens and settings go.

1. In Railway, click on your service (the box that appeared)
2. Go to the **"Variables"** tab
3. Click **"Add Variable"** for each one below

**Required variables** (the bot won't start without these):

| Variable | Value |
|---|---|
| `SLACK_BOT_TOKEN` | `xoxb-...` (from Step 7) |
| `SLACK_SIGNING_SECRET` | The signing secret (from Step 7) |
| `SLACK_APP_TOKEN` | `xapp-...` (from Step 2) |
| `AUTHORIZED_USERS` | `U01ABC123XY` (from Step 9, comma-separated if multiple) |

**AI Provider** (pick ONE set based on which provider you chose in Step 8):

If you chose **OpenRouter** (Option A):

| Variable | Value |
|---|---|
| `AI_PROVIDER` | `openrouter` |
| `OPENROUTER_API_KEY` | `sk-or-...` (from Step 8) |

If you chose **Anthropic** (Option B):

| Variable | Value |
|---|---|
| `AI_PROVIDER` | `anthropic` |
| `ANTHROPIC_API_KEY` | `sk-ant-...` (from Step 8) |

**Personalization** (optional but recommended — makes the bot yours):

| Variable | Example | What it does |
|---|---|---|
| `BOT_OWNER_NAME` | `Sarah` | The AI calls itself "Sarah's assistant" |
| `OWNER_ROLE` | `a marketing agency owner` | Helps the AI understand your perspective |
| `DRAFT_STYLE` | `professional` | Tone of suggested messages: `casual`, `professional`, or `friendly` |
| `BOT_PERSONALITY` | `Be brief. Use bullet points.` | Extra instructions for how the AI talks to you |

**Example: Full setup for someone named Sarah who runs a design agency:**

| Variable | Value |
|---|---|
| `SLACK_BOT_TOKEN` | `xoxb-123-456-abc` |
| `SLACK_SIGNING_SECRET` | `abc123def456` |
| `SLACK_APP_TOKEN` | `xapp-1-A0B-789-xyz` |
| `AUTHORIZED_USERS` | `U01SARAH` |
| `AI_PROVIDER` | `openrouter` |
| `OPENROUTER_API_KEY` | `sk-or-v1-abc123` |
| `BOT_OWNER_NAME` | `Sarah` |
| `OWNER_ROLE` | `a design agency owner` |
| `DRAFT_STYLE` | `professional` |

**Other optional variables:**

| Variable | Default | What it does |
|---|---|---|
| `AI_MODEL` | _(auto, based on provider)_ | Override the AI model. Browse options at https://openrouter.ai/models |
| `TEAM_USER_IDS` | (same as AUTHORIZED_USERS) | Comma-separated Slack user IDs of your team members (helps the bot tell "team" from "client") |
| `EXCLUDE_CHANNELS` | `general,random` | Channel names to skip during scans |
| `DRAFTS_ENABLED` | `true` | Set to `false` to turn off draft message suggestions |
| `BOT_PERSONALITY` | _(none)_ | Freeform instructions for how the AI talks to you |

### 10d. Add a Persistent Volume (CRITICAL)

This is where the bot stores its database. Without this, all data resets every time you deploy.

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
[INFO] [ai-provider] Active provider: openrouter | model: anthropic/claude-sonnet-4-5
[INFO] [startup] Slack Project Tracker Bot is running!
[INFO] [startup] Syncing users...
[INFO] [startup] Synced 47 users
[INFO] [startup] Found 23 channels
[INFO] [backfill] #general done — 8 members, 156 messages, 12 threads
...
[INFO] [startup] Bot is fully operational.
```

If you see errors, check:
- All required environment variables are set correctly
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

## Draft Message Styles

The bot can suggest draft messages when channels need a response. Set `DRAFT_STYLE` to change the tone:

| Style | Greeting | Sign-off | Best for |
|---|---|---|---|
| `casual` (default) | "Hey John" | "Happy Monday!" | Friendly, personal client relationships |
| `professional` | "Hi John" | "Best regards." | Corporate clients, formal communication |
| `friendly` | "Hi John!" | "Have a great day!" | Warm but less personal than casual |

**Same situation, three styles:**

> **casual:** Hey John, I hear you on this and I totally understand the frustration with your website. I'm personally making sure this gets resolved. Happy Wednesday!
>
> **professional:** Hi John, I understand your frustration with your website and I take this seriously. I'm personally overseeing the resolution and will follow up with you directly today. Best regards.
>
> **friendly:** Hi John, I completely understand your frustration with your website. I'm making this a priority and will personally follow up with you today. Have a great day!

Set `DRAFTS_ENABLED=false` to turn off draft suggestions entirely. You still get the priority queue and analysis — just no suggested messages.

---

## Morning Scan

Every weekday at **7:00 AM Pacific**, the bot automatically scans all active channels and DMs you a prioritized queue:

- **RESPOND NOW** (priority 70+) — frustrated clients, long-waiting messages
- **RESPOND TODAY** (priority 40-69) — questions, requests, check-ins
- **LOW PRIORITY** (priority 20-39) — can wait if needed

Each entry shows why it needs attention, the client's mood, and (if drafts are enabled) a suggested message you can copy-paste or edit.

You can also trigger this manually anytime with the `/scan` command.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Bot doesn't respond to DMs | Go to Slack App Settings → **App Home** → make sure Messages Tab is ON and the checkbox is checked |
| `missing_scope` error in logs | You missed a scope in Step 3 — add it in OAuth & Permissions and **reinstall the app** (Step 7) |
| `not_authed` or `invalid_auth` | Wrong Slack token — double-check SLACK_BOT_TOKEN and SLACK_APP_TOKEN |
| `Invalid API key` | Wrong AI key — check your AI_PROVIDER matches the key you set (OPENROUTER_API_KEY or ANTHROPIC_API_KEY) |
| `Unknown AI_PROVIDER` | AI_PROVIDER must be exactly `openrouter` or `anthropic` (lowercase) |
| Bot crashes and restarts | Check Railway logs — the error message will tell you what's wrong |
| Data gone after redeploy | Volume not mounted — redo Step 10d |
| Bot doesn't join channels | Missing `channels:join` scope — add it and reinstall |
| No morning scan DMs | `AUTHORIZED_USERS` not set — add your Slack user ID |
| AI responses are slow | Normal — AI calls take 3-10 seconds. If consistently >30s, try a faster model via AI_MODEL |

---

## Ongoing Cost

| Item | Cost |
|---|---|
| Railway hosting | ~$5/month |
| AI (per question) | ~$0.01-0.05 depending on model |
| Slack | Free (bot uses no paid features) |
| **Total for normal use** | **~$10-15/month** |

---

## AI Models

If you're using OpenRouter, you can change which AI model powers the bot by setting `AI_MODEL`. Some popular options:

| Model | AI_MODEL value | Speed | Quality | Cost |
|---|---|---|---|---|
| Claude Sonnet 4.5 (default) | `anthropic/claude-sonnet-4-5` | Fast | Excellent | $$ |
| Claude Opus 4.5 | `anthropic/claude-opus-4-5` | Slower | Best | $$$$ |
| GPT-4o | `openai/gpt-4o` | Fast | Excellent | $$ |
| Gemini 2.5 Pro | `google/gemini-2.5-pro` | Fast | Great | $ |
| Llama 4 Maverick | `meta-llama/llama-4-maverick` | Fast | Good | $ |

Browse all available models at **https://openrouter.ai/models**

Leave `AI_MODEL` blank to use the default (Claude Sonnet 4.5 — recommended).

---

## Tech Stack

| Component | Technology |
|---|---|
| Framework | Slack Bolt.js (Slack's official Node.js SDK) |
| Connection | Socket Mode (WebSocket — no public URL needed) |
| Database | SQLite (local file, zero config, stored on Railway volume) |
| AI | Configurable — Claude, GPT-4, Gemini, Llama, or any OpenRouter model |
| Hosting | Railway (24/7 uptime, auto-deploy from GitHub) |
| Logging | File + console (viewable in Railway dashboard) |
