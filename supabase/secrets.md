# Supabase Edge Function Secrets Setup

This guide walks you through deploying the Edge Functions and wiring up all required secrets.

---

## Step 1 — Extract your Gmail refresh token

> **Two OAuth clients are in use:**
> - **Web application client** (`GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` in `.env`) → used here for Supabase secrets
> - **Desktop app client** (`GMAIL_LOCAL_CLIENT_ID` / `GMAIL_LOCAL_CLIENT_SECRET` in `.env`) → used only by `gmail_fetch.py --auth` locally
>
> Use the **Web application** credentials in this step, not the Desktop app ones.

Your refresh token lives in `pipeline/gmail_token.json`. Run this in your terminal:

```bash
cd /Users/ejjung/Documents/dev/ejnewsfeed
cat pipeline/gmail_token.json
```

Look for the `"refresh_token"` field. It starts with `1//01...` and is a long string.
Copy it — you'll need it in Step 3.

Also open `pipeline/.env` and note:
- `GMAIL_CLIENT_ID` (Web application client — use this one)
- `GMAIL_CLIENT_SECRET` (Web application client — use this one)
- `ANTHROPIC_API_KEY`

---

## Step 2 — Install Supabase CLI (if not already installed)

```bash
brew install supabase/tap/supabase
```

Log in and link your project:

```bash
supabase login
cd /Users/ejjung/Documents/dev/ejnewsfeed
supabase link --project-ref oqxxmdyyfjgigfjtposv
```

When prompted for the database password, find it in:
Supabase Dashboard → Project Settings → Database → Database Password

---

## Step 3 — Set secrets for the Edge Functions

Run each command below, replacing the placeholder values with your real credentials:

```bash
# Gmail OAuth credentials (from pipeline/.env)
supabase secrets set GMAIL_CLIENT_ID="your_client_id_here"
supabase secrets set GMAIL_CLIENT_SECRET="your_client_secret_here"

# Gmail refresh token (from pipeline/gmail_token.json)
supabase secrets set GMAIL_REFRESH_TOKEN="1//01INdDz..."

# Anthropic API key (from pipeline/.env — no trailing period!)
supabase secrets set ANTHROPIC_API_KEY="sk-ant-..."
```

Verify all secrets are set:

```bash
supabase secrets list
```

You should see: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `ANTHROPIC_API_KEY`

> Note: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are automatically injected
> into every Edge Function — you don't need to set those manually.

---

## Step 4 — Deploy the Edge Functions

```bash
cd /Users/ejjung/Documents/dev/ejnewsfeed

# Deploy both functions
supabase functions deploy fetch-emails
supabase functions deploy process-emails
```

After deployment, verify in Supabase Dashboard → Edge Functions — both should show as Active.

---

## Step 5 — Set up the pg_cron schedule

1. Go to **Supabase Dashboard → Settings → Extensions**
2. Enable **pg_cron** and **pg_net**
3. Go to **SQL Editor → New Query**
4. Open `supabase/pg_cron.sql` in your editor
5. Update line with `YOUR_SUPABASE_ANON_KEY_HERE` — find your anon key at:
   Supabase Dashboard → Project Settings → API → `anon public` key
6. Run the entire SQL file

---

## Step 6 — Test manually (recommended before relying on the schedule)

Trigger fetch-emails manually from your terminal:

```bash
# Get your anon key first
supabase status

# Or test via curl:
curl -X POST \
  https://oqxxmdyyfjgigfjtposv.supabase.co/functions/v1/fetch-emails \
  -H "Authorization: Bearer YOUR_ANON_KEY" \
  -H "Content-Type: application/json"
```

Check the response — it should return `{ "ok": true, "saved": N, ... }`.

Wait a few seconds, then trigger process-emails:

```bash
curl -X POST \
  https://oqxxmdyyfjgigfjtposv.supabase.co/functions/v1/process-emails \
  -H "Authorization: Bearer YOUR_ANON_KEY" \
  -H "Content-Type: application/json"
```

Check Supabase Dashboard → Table Editor → `articles` to confirm new rows appeared.

---

## Step 7 — Deploy latest dashboard to Vercel

After all the backend is running, redeploy the frontend to pick up recent fixes:

```bash
cd /Users/ejjung/Documents/dev/ejnewsfeed/dashboard
vercel --prod
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Gmail token refresh failed` | Wrong refresh token or credentials | Re-check secrets with `supabase secrets list` |
| `Claude API error 401` | Wrong or expired API key | Update `ANTHROPIC_API_KEY` secret |
| `Failed to load categories: empty` | Categories table empty | Run `seed.sql` in SQL Editor |
| Edge Function times out | Too many emails to process | Normal — remaining emails process next run |
| `cron.schedule` fails | pg_cron not enabled | Enable in Dashboard → Extensions |

---

## Monitoring

Check Edge Function logs in real time:

```bash
supabase functions logs fetch-emails --tail
supabase functions logs process-emails --tail
```

Check pg_cron job history in SQL Editor:

```sql
SELECT jobname, status, start_time, end_time
FROM cron.job_run_details
ORDER BY start_time DESC
LIMIT 20;
```
