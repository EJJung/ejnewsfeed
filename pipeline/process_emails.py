"""
process_emails.py
=================
Reads unprocessed raw_emails from Supabase, uses Claude to:
  1. Extract individual articles from each newsletter
  2. Categorize each article into your 5 interest areas
  3. Generate a daily synthesized summary per category

Run daily after gmail_fetch.py:  python process_emails.py
Or run both together:            python process_emails.py --fetch-first
"""

import os
import json
from datetime import date, datetime, timezone
from dotenv import load_dotenv
import html2text
import anthropic
from supabase import create_client

load_dotenv()

ANTHROPIC_KEY  = os.environ['ANTHROPIC_API_KEY']
SUPABASE_URL   = os.environ['SUPABASE_URL']
SUPABASE_KEY   = os.environ['SUPABASE_SERVICE_ROLE_KEY']

claude  = anthropic.Anthropic(api_key=ANTHROPIC_KEY)
sb      = create_client(SUPABASE_URL, SUPABASE_KEY)
h2t     = html2text.HTML2Text()
h2t.ignore_links   = False
h2t.ignore_images  = True
h2t.body_width     = 0

CATEGORIES = ['AI', 'IT', 'Entrepreneurship', 'UX Design', 'Business']

INTEREST_CONTEXT = """
EJ's five interest areas:
- AI: Artificial intelligence, machine learning, LLMs, AI products, AI policy and regulation
- IT: Software engineering, developer tools, infrastructure, cloud, hardware, cybersecurity
- Entrepreneurship: Startups, venture capital, founder stories, fundraising, growth strategies, product-market fit
- UX Design: User experience, product design, design systems, design tools, interface patterns, accessibility
- Business: Corporate strategy, markets, M&A, macroeconomics, leadership, company earnings
"""


# ── Article extraction ────────────────────────────────────────────────────────

EXTRACT_PROMPT = """You are extracting articles from a newsletter email.

{interest_context}

Newsletter content:
<newsletter>
{content}
</newsletter>

Extract each distinct article or story from this newsletter. For each one, output a JSON object.
Return a JSON array. Each object must have:
- title: string — the article headline
- url: string | null — the article link if present
- snippet: string — 2-3 sentence summary of the article content
- primary_category: string — ONE of: AI, IT, Entrepreneurship, UX Design, Business
- category_tags: string[] — all relevant categories (1–3 items)
- relevance_score: number — 0.0 to 1.0, how relevant this is to EJ's interest areas

Only include articles that are relevant to at least one of EJ's interest areas.
Return ONLY valid JSON, no other text."""


def extract_articles_from_email(raw_email):
    """Use Claude to extract and categorize articles from a raw email."""
    # Convert HTML to markdown for cleaner processing
    if raw_email.get('raw_html'):
        content = h2t.handle(raw_email['raw_html'])
    elif raw_email.get('raw_text'):
        content = raw_email['raw_text']
    else:
        return []

    # Truncate to avoid token limits (most newsletters fit well within this)
    content = content[:12000]

    try:
        response = claude.messages.create(
            model='claude-sonnet-4-6',
            max_tokens=4096,
            messages=[{
                'role': 'user',
                'content': EXTRACT_PROMPT.format(
                    interest_context=INTEREST_CONTEXT,
                    content=content,
                )
            }]
        )

        text = response.content[0].text.strip()
        # Strip markdown code blocks if present
        if text.startswith('```'):
            text = text.split('```')[1]
            if text.startswith('json'):
                text = text[4:]
        articles = json.loads(text)
        return articles if isinstance(articles, list) else []

    except Exception as e:
        print(f"    ✗ Extraction error: {e}")
        return None  # None = API/processing error; [] = success with no relevant articles


# ── Daily summary generation ──────────────────────────────────────────────────

SUMMARY_PROMPT = """You are EJ's personal news analyst. Generate a synthesized morning briefing for one interest area.

{interest_context}

Today's articles in the "{category}" category:
<articles>
{articles_text}
</articles>

Write a 3–4 sentence synthesized briefing paragraph for EJ's morning reading.
- Identify the dominant theme or tension across today's articles
- Be analytical, not just a list recap — draw connections and highlight what's significant
- Use direct, intelligent prose. No bullet points. No headers.
- End with what EJ should watch for or pay attention to.

Return only the paragraph text, nothing else."""


def generate_daily_summary(category_name, articles):
    """Generate a synthesized daily summary for one category."""
    articles_text = '\n\n'.join([
        f"• {a['title']}\n  {a.get('snippet', '')}"
        for a in articles
    ])

    try:
        response = claude.messages.create(
            model='claude-sonnet-4-6',
            max_tokens=512,
            messages=[{
                'role': 'user',
                'content': SUMMARY_PROMPT.format(
                    interest_context=INTEREST_CONTEXT,
                    category=category_name,
                    articles_text=articles_text,
                )
            }]
        )
        return response.content[0].text.strip()
    except Exception as e:
        print(f"    ✗ Summary error for {category_name}: {e}")
        return None


# ── Database helpers ──────────────────────────────────────────────────────────

def get_category_id(name):
    result = sb.table('categories').select('id').eq('name', name).execute()
    return result.data[0]['id'] if result.data else None


def save_articles(extracted, raw_email_id, source_id):
    saved = []
    for art in extracted:
        cat_id = get_category_id(art.get('primary_category'))
        row = {
            'raw_email_id':        raw_email_id,
            'source_id':           source_id,
            'title':               art.get('title', ''),
            'url':                 art.get('url'),
            'snippet':             art.get('snippet', ''),
            'primary_category_id': cat_id,
            'category_tags':       art.get('category_tags', []),
            'relevance_score':     art.get('relevance_score', 0.5),
            'published_at':        datetime.now(timezone.utc).isoformat(),
        }
        result = sb.table('articles').insert(row).execute()
        if result.data:
            saved.append(result.data[0])
    return saved


def upsert_daily_summary(date_str, category_name, summary, article_count):
    cat_id = get_category_id(category_name)
    if not cat_id:
        return
    sb.table('daily_summaries').upsert({
        'date':           date_str,
        'category_id':    cat_id,
        'summary':        summary,
        'article_count':  article_count,
        'generated_at':   datetime.now(timezone.utc).isoformat(),
    }, on_conflict='date,category_id').execute()


# ── Reprocess helpers ─────────────────────────────────────────────────────────

def reset_today_emails():
    """Reset today's processed emails back to unprocessed so they can be retried."""
    today_str = date.today().isoformat()
    result = sb.table('raw_emails') \
        .update({'processed': False}) \
        .eq('processed', True) \
        .gte('received_at', f'{today_str}T00:00:00Z') \
        .execute()
    count = len(result.data or [])
    print(f"Reset {count} email(s) to unprocessed for today ({today_str}).\n")


# ── Main pipeline ─────────────────────────────────────────────────────────────

def run_pipeline():
    today_str = date.today().isoformat()
    print(f"\n{'='*55}")
    print(f"EJ Newsfeed Pipeline — {today_str}")
    print(f"{'='*55}\n")

    # 1. Fetch unprocessed emails
    unprocessed = sb.table('raw_emails') \
        .select('*') \
        .eq('processed', False) \
        .execute()

    emails = unprocessed.data or []
    print(f"Found {len(emails)} unprocessed email(s).\n")

    all_articles_by_category = {cat: [] for cat in CATEGORIES}

    # 2. Extract articles from each email
    for email in emails:
        subject = email.get('subject', '(no subject)')
        print(f"Processing: {subject[:60]}")

        extracted = extract_articles_from_email(email)
        if extracted is None:
            print(f"  → Extraction failed — email stays unprocessed for retry")
            continue

        print(f"  → {len(extracted)} article(s) extracted")

        save_articles(extracted, email['id'], email.get('source_id'))

        for art in extracted:
            cat = art.get('primary_category')
            if cat in all_articles_by_category:
                all_articles_by_category[cat].append(art)

        # Mark email as processed only on success
        sb.table('raw_emails').update({'processed': True}).eq('id', email['id']).execute()

    # 3. Also gather today's previously processed articles for summaries
    existing_today = sb.table('articles') \
        .select('*, category:categories(name)') \
        .gte('published_at', f'{today_str}T00:00:00Z') \
        .execute()

    for art in (existing_today.data or []):
        cat_name = art.get('category', {}).get('name')
        if cat_name and cat_name in all_articles_by_category:
            # Avoid duplicates from this run
            if not any(a.get('title') == art.get('title') for a in all_articles_by_category[cat_name]):
                all_articles_by_category[cat_name].append(art)

    # 4. Generate daily summaries for each category
    print(f"\nGenerating daily summaries for {today_str}...")
    for cat_name, articles in all_articles_by_category.items():
        if not articles:
            print(f"  {cat_name}: no articles today, skipping")
            continue

        print(f"  {cat_name}: {len(articles)} article(s) → generating summary...")
        summary = generate_daily_summary(cat_name, articles)
        if summary:
            upsert_daily_summary(today_str, cat_name, summary, len(articles))
            print(f"  ✓ {cat_name} summary saved")

    print(f"\n✓ Pipeline complete for {today_str}")


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--fetch-first', action='store_true',
                        help='Run gmail_fetch.py before processing')
    parser.add_argument('--reprocess-today', action='store_true',
                        help='Reset today\'s emails to unprocessed, then re-run the pipeline')
    args = parser.parse_args()

    if args.reprocess_today:
        reset_today_emails()

    if args.fetch_first:
        from gmail_fetch import get_gmail_service, fetch_new_emails
        service = get_gmail_service()
        fetch_new_emails(service, sb)

    run_pipeline()
