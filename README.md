# EJ Newsfeed

A personal AI-powered news intelligence system for IT, Entrepreneurship, UX Design, Business, and AI.

---

## How It Works

**Every morning:**
1. Newsletters arrive in `ej.newsfeed@gmail.com`
2. The pipeline fetches them via Gmail API
3. Claude extracts individual articles and categorizes each one
4. Claude generates a synthesized briefing paragraph per interest area
5. Everything is stored in Supabase
6. You open the dashboard and read your morning briefing

**When you dive into an article:**
- Claude fetches the full piece and generates a structured analysis (key points, so-what, implications)
- A chat window lets you ask follow-up questions

---

## Project Structure

```
ejnewsfeed/
├── schema.sql          # Supabase database schema (run first)
├── seed.sql            # Categories and initial sources
├── dashboard/          # React web dashboard
│   ├── src/
│   │   ├── components/ # Sidebar, ScanView, DiveView, ChatPanel, ArticleCard
│   │   └── lib/        # Supabase client, mock data
│   └── .env.example    # → copy to .env with your Supabase keys
└── pipeline/           # Python processing scripts
    ├── gmail_fetch.py      # Pulls emails from Gmail API → Supabase
    ├── process_emails.py   # Claude extraction + summarization
    ├── requirements.txt
    └── .env.example    # → copy to .env with your API keys
```

---

## Setup Guide

### Step 1 — Supabase

1. Create a free project at [supabase.com](https://supabase.com)
2. In the SQL Editor, run `schema.sql` then `seed.sql`
3. Copy your project URL and anon key from **Settings → API**

### Step 2 — Dashboard

```bash
cd dashboard
cp .env.example .env       # Add your Supabase URL and anon key
npm install
npm run dev                # Opens at http://localhost:5173
```

> The dashboard works in **demo mode** with sample data before Supabase is connected.

### Step 3 — Gmail API

1. Go to [Google Cloud Console](https://console.cloud.google.com) → New project
2. Enable the **Gmail API**
3. Create **OAuth 2.0 credentials** (Desktop app type)
4. Copy the Client ID and Secret

### Step 4 — Pipeline

```bash
cd pipeline
cp .env.example .env       # Add Anthropic, Supabase, and Gmail credentials
pip install -r requirements.txt

# First run: authorize Gmail access (opens browser)
python gmail_fetch.py --auth

# Test the full pipeline manually
python process_emails.py --fetch-first
```

### Step 5 — Automate (via Cowork Scheduled Task)

Create a scheduled task in Cowork that runs each morning:

```
Run this command every weekday at 7am:
cd /path/to/ejnewsfeed/pipeline && python process_emails.py --fetch-first
```

---

## Gmail Forwarding Setup

Until you re-subscribe newsletters directly to `ej.newsfeed@gmail.com`, set up
forwarding from your main Gmail:

1. In your main Gmail, go to **Settings → Filters and Blocked Addresses**
2. Create a filter: `from:(newsletter-sender@example.com)` → **Forward to** `ej.newsfeed@gmail.com`
3. Repeat for each newsletter source

---

## Recommendations (Future Phase)

The `user_interactions` table tracks every article open, save, and dismiss from day one.
Once 4–6 weeks of data has accumulated, a recommendation layer can be added that:

- Scores incoming articles against your historical engagement patterns
- Surfaces articles you'd likely find valuable but didn't come from your subscribed sources
- Adjusts category weighting based on what you actually read vs. skim

---

## Tech Stack

| Layer | Technology |
|---|---|
| Database | Supabase (PostgreSQL) |
| Email ingestion | Gmail API (Python) |
| AI processing | Claude (Anthropic API) |
| Dashboard | React + Tailwind CSS + Vite |
| Scheduling | Cowork scheduled task |
