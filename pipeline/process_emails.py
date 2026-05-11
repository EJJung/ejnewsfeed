"""
process_emails.py
=================
Reads unprocessed raw_emails from Supabase, uses Claude to:
  1. Extract individual articles from each newsletter
  2. Categorize each article into your 5 interest areas
  3. Score each article's impact (0.0–1.0) across 5 signals
  4. Generate a daily synthesized summary per category

Run daily after gmail_fetch.py:  python process_emails.py
Or run both together:            python process_emails.py --fetch-first
"""

import os
import re
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


# ── Impact scoring ────────────────────────────────────────────────────────────

# Signal weights — must sum to 1.0
WEIGHTS = {
    'source_authority':    0.25,
    'story_reach':         0.20,
    'signal_keywords':     0.20,
    'cross_category':      0.15,
    'personal_engagement': 0.20,
}

# Cache source tier lookups to avoid repeated DB calls within a run
_source_tier_cache: dict[str, str] = {}

TIER_SCORES = {'A': 1.0, 'B': 0.6, 'C': 0.3}

TITLE_STOPWORDS = {
    'a', 'an', 'the', 'and', 'or', 'in', 'of', 'to', 'is', 'it',
    'for', 'on', 'at', 'by', 'with', 'how', 'why', 'what', 'this',
    'that', 'are', 'has', 'have', 'was', 'will', 'its', 'be', 'as',
    'from', 'but', 'not', 'new', 'your',
}


def get_source_authority_score(source_id: str | None) -> float:
    """Return 0.0–1.0 based on the source's manually set tier (A/B/C)."""
    if not source_id:
        return TIER_SCORES['C']
    if source_id not in _source_tier_cache:
        result = sb.table('sources').select('tier').eq('id', source_id).execute()
        tier = result.data[0]['tier'] if result.data else 'C'
        _source_tier_cache[source_id] = tier
    return TIER_SCORES.get(_source_tier_cache[source_id], TIER_SCORES['C'])


def compute_story_reach_scores(all_articles: list[dict]) -> list[float]:
    """
    For each article, count how many distinct sources cover an overlapping
    story (detected by 2+ significant title keywords in common).
    Returns a list of reach scores parallel to all_articles.

    1 source  → 0.2
    2 sources → 0.6
    3+ sources → 1.0
    """
    def keywords(title: str) -> set[str]:
        words = re.findall(r'\b[a-z]{4,}\b', title.lower())
        return {w for w in words if w not in TITLE_STOPWORDS}

    kw_sets = [keywords(a.get('title', '')) for a in all_articles]
    reach_scores = []

    for i, art_i in enumerate(all_articles):
        if not kw_sets[i]:
            reach_scores.append(0.2)
            continue

        matching_sources: set = {art_i.get('_source_id', f'_self_{i}')}
        for j, art_j in enumerate(all_articles):
            if i == j:
                continue
            if len(kw_sets[i] & kw_sets[j]) >= 2:
                matching_sources.add(art_j.get('_source_id', f'_other_{j}'))

        n = len(matching_sources)
        if n >= 3:
            reach_scores.append(1.0)
        elif n == 2:
            reach_scores.append(0.6)
        else:
            reach_scores.append(0.2)

    return reach_scores


def get_personal_engagement_score(source_id: str | None) -> float:
    """
    Returns a 0.1–1.0 score based on how often EJ has done high-signal
    actions (read_full, saved, chat_started) on articles from this source.
    Defaults to 0.5 until at least 10 interactions exist.
    """
    if not source_id:
        return 0.5
    try:
        result = (
            sb.table('user_interactions')
            .select('action, article:articles!inner(source_id)')
            .eq('article.source_id', source_id)
            .execute()
        )
        interactions = result.data or []
        if len(interactions) < 10:
            return 0.5  # not enough signal yet

        high_signal = sum(
            1 for i in interactions
            if i['action'] in ('read_full', 'saved', 'chat_started')
        )
        return round(min(max(high_signal / len(interactions), 0.1), 1.0), 3)
    except Exception:
        return 0.5


def compute_impact_score(
    signal_keywords_score: float,
    source_authority_score: float,
    reach_score: float,
    personal_score: float,
    category_tags: list[str],
) -> float:
    """
    Combine the five signals into a single 0.0–1.0 impact score.

    signal_keywords_score  — Claude-assessed importance of the news event
    source_authority_score — Source tier (A=1.0, B=0.6, C=0.3)
    reach_score            — How many distinct sources covered this story
    personal_score         — EJ's historical engagement with this source
    category_tags          — Number of interest areas the article spans
    """
    # Cross-category: 1 tag → 0.0, 2 tags → 0.5, 3 tags → 1.0
    cross_cat = min((len(category_tags) - 1) / 2.0, 1.0) if category_tags else 0.0

    raw = (
        WEIGHTS['source_authority']    * source_authority_score +
        WEIGHTS['story_reach']         * reach_score +
        WEIGHTS['signal_keywords']     * signal_keywords_score +
        WEIGHTS['cross_category']      * cross_cat +
        WEIGHTS['personal_engagement'] * personal_score
    )
    return round(min(max(raw, 0.0), 1.0), 3)


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
- signal_keywords_score: number — 0.0 to 1.0, objective newsworthiness of the event itself.
    Score 0.8–1.0: major funding round / acquisition / IPO, significant product launch by a major player,
                   important regulation or policy change, notable research breakthrough, large-scale layoffs.
    Score 0.4–0.7: meaningful but not landmark — mid-stage startup news, useful tool releases, industry trends.
    Score 0.0–0.3: opinion pieces, predictions, how-to guides, roundups, listicles.

Only include articles that are relevant to at least one of EJ's interest areas.
Return ONLY valid JSON, no other text."""


def extract_articles_from_email(raw_email: dict) -> list[dict] | None:
    """Use Claude to extract and categorize articles from a raw email.
    Returns None on API/processing error so the email can be retried.
    """
    if raw_email.get('raw_html'):
        content = h2t.handle(raw_email['raw_html'])
    elif raw_email.get('raw_text'):
        content = raw_email['raw_text']
    else:
        return []

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
        if text.startswith('```'):
            text = text.split('```')[1]
            if text.startswith('json'):
                text = text[4:]
        articles = json.loads(text)
        return articles if isinstance(articles, list) else []

    except Exception as e:
        print(f"    ✗ Extraction error: {e}")
        return None


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


def generate_daily_summary(category_name: str, articles: list[dict]) -> str | None:
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

def get_category_id(name: str) -> str | None:
    result = sb.table('categories').select('id').eq('name', name).execute()
    return result.data[0]['id'] if result.data else None


def save_articles(extracted: list[dict], raw_email_id: str, source_id: str | None) -> list[dict]:
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
            'impact_score':        art.get('_impact_score', 0.5),
            'published_at':        datetime.now(timezone.utc).isoformat(),
        }
        result = sb.table('articles').insert(row).execute()
        if result.data:
            saved.append(result.data[0])
    return saved


def upsert_daily_summary(date_str: str, category_name: str, summary: str, article_count: int):
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

    # ── Phase 1: Extract articles from all emails ─────────────────────────────
    # Collect everything before computing reach scores (which need the full set).
    extraction_results: list[tuple[list[dict], dict]] = []  # (articles, email)

    for email in emails:
        subject = email.get('subject', '(no subject)')
        print(f"Processing: {subject[:60]}")

        extracted = extract_articles_from_email(email)
        if extracted is None:
            print(f"  → Extraction failed — email stays unprocessed for retry")
            continue

        print(f"  → {len(extracted)} article(s) extracted")
        # Tag each article with its source so reach scoring can group by source
        for art in extracted:
            art['_source_id'] = email.get('source_id')

        extraction_results.append((extracted, email))

    # ── Phase 2: Compute impact scores ───────────────────────────────────────
    # Flatten all articles for cross-email story reach detection
    all_flat: list[dict] = [art for arts, _ in extraction_results for art in arts]

    if all_flat:
        print(f"\nScoring impact for {len(all_flat)} article(s)...")
        reach_scores = compute_story_reach_scores(all_flat)

        for i, art in enumerate(all_flat):
            source_id          = art.get('_source_id')
            authority_score    = get_source_authority_score(source_id)
            reach_score        = reach_scores[i]
            keyword_score      = float(art.get('signal_keywords_score', 0.5))
            personal_score     = get_personal_engagement_score(source_id)
            category_tags      = art.get('category_tags', [])

            art['_impact_score'] = compute_impact_score(
                signal_keywords_score  = keyword_score,
                source_authority_score = authority_score,
                reach_score            = reach_score,
                personal_score         = personal_score,
                category_tags          = category_tags,
            )

    # ── Phase 3: Save articles and mark emails processed ─────────────────────
    all_articles_by_category = {cat: [] for cat in CATEGORIES}

    for extracted, email in extraction_results:
        save_articles(extracted, email['id'], email.get('source_id'))

        for art in extracted:
            cat = art.get('primary_category')
            if cat in all_articles_by_category:
                all_articles_by_category[cat].append(art)

        sb.table('raw_emails').update({'processed': True}).eq('id', email['id']).execute()

    # ── Phase 4: Pull today's previously saved articles for summaries ─────────
    existing_today = sb.table('articles') \
        .select('*, category:categories(name)') \
        .gte('published_at', f'{today_str}T00:00:00Z') \
        .execute()

    for art in (existing_today.data or []):
        cat_name = art.get('category', {}).get('name')
        if cat_name and cat_name in all_articles_by_category:
            if not any(a.get('title') == art.get('title') for a in all_articles_by_category[cat_name]):
                all_articles_by_category[cat_name].append(art)

    # ── Phase 5: Generate daily summaries ────────────────────────────────────
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
                        help="Reset today's emails to unprocessed, then re-run the pipeline")
    args = parser.parse_args()

    if args.reprocess_today:
        reset_today_emails()

    if args.fetch_first:
        from gmail_fetch import get_gmail_service, fetch_new_emails
        service = get_gmail_service()
        fetch_new_emails(service, sb)

    run_pipeline()
