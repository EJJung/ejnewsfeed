"""
audit_pipeline.py
=================
End-to-end health audit for the EJ Newsfeed pipeline.

Covers four stages:
  1. Email fetch     — raw_emails ingestion from Gmail
  2. Article parsing — extraction quality from newsletters
  3. Article scoring — impact / relevance score health
  4. Summarization   — daily summary coverage per category

Usage:
  python audit_pipeline.py                     # audit today
  python audit_pipeline.py --days 7            # extend lookback window
  python audit_pipeline.py --date 2026-05-20   # audit a specific date
  python audit_pipeline.py --md                # also write a markdown report
"""

import os
import sys
import argparse
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from dotenv import load_dotenv
from supabase import create_client

# Load .env from the same directory as this script
load_dotenv(Path(__file__).parent / ".env")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

if not SUPABASE_URL or not SUPABASE_KEY:
    sys.exit(
        "ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set "
        "(via pipeline/.env or environment variables)."
    )

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

CATEGORIES = ["AI", "IT", "Entrepreneurship", "UX Design", "Business"]

# ANSI colours
GREEN  = "\033[92m"
YELLOW = "\033[93m"
RED    = "\033[91m"
CYAN   = "\033[96m"
BOLD   = "\033[1m"
DIM    = "\033[2m"
RESET  = "\033[0m"

ICONS = {"pass": "✅", "warn": "⚠️ ", "fail": "❌", "info": "ℹ️ "}
COLOUR = {"pass": GREEN, "warn": YELLOW, "fail": RED, "info": CYAN}


# ── Helpers ────────────────────────────────────────────────────────────────────

class CheckResult:
    def __init__(self, status: str, label: str, detail: str):
        self.status = status   # pass | warn | fail | info
        self.label  = label
        self.detail = detail

    def render_console(self) -> str:
        icon   = ICONS[self.status]
        colour = COLOUR[self.status]
        return f"  {icon}  {colour}{self.label}{RESET}: {self.detail}"

    def render_md(self) -> str:
        icon = ICONS[self.status].strip()
        return f"| {icon} | **{self.label}** | {self.detail} |"


def _pct(numerator: int, denominator: int) -> str:
    if not denominator:
        return "n/a"
    return f"{round(numerator / denominator * 100)}%"


def _score_distribution(scores: list[float]) -> str:
    low  = sum(1 for s in scores if s < 0.4)
    mid  = sum(1 for s in scores if 0.4 <= s < 0.7)
    high = sum(1 for s in scores if s >= 0.7)
    return f"low(<0.4)={low}  mid(0.4–0.7)={mid}  high(≥0.7)={high}"


def _duplicate_url_count(articles: list[dict]) -> int:
    urls = [a["url"] for a in articles if a.get("url")]
    return len(urls) - len(set(urls))


def _avg(values: list[float]) -> float:
    return round(sum(values) / len(values), 3) if values else 0.0


# ── Stage 1: Email Fetch ───────────────────────────────────────────────────────

def audit_email_fetch(target_date: date) -> list[CheckResult]:
    date_str = target_date.isoformat()
    results  = []

    # Unprocessed backlog — split into "stuck" and "pending".
    # process-emails works through a rolling 72h window, so recent unprocessed
    # emails are normal (they'll be picked up by upcoming runs). Only emails
    # OLDER than the window are truly stuck and demand attention.
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=72)).isoformat()

    stuck_q = sb.table("raw_emails") \
        .select("id", count="exact") \
        .eq("processed", False) \
        .lt("received_at", cutoff) \
        .execute()
    n_stuck = stuck_q.count or 0

    pending_q = sb.table("raw_emails") \
        .select("id", count="exact") \
        .eq("processed", False) \
        .gte("received_at", cutoff) \
        .execute()
    n_pending = pending_q.count or 0

    if n_stuck == 0:
        results.append(CheckResult("pass", "stuck backlog (>72h)",
                                   "0 emails outside the processing window"))
    elif n_stuck <= 5:
        results.append(CheckResult("warn", "stuck backlog (>72h)",
                                   f"{n_stuck} email(s) fell outside the 72h processing window"))
    else:
        results.append(CheckResult("fail", "stuck backlog (>72h)",
                                   f"{n_stuck} emails outside the 72h processing window — capacity too low or runs failing"))

    results.append(CheckResult("info", "pending (<72h)",
                               f"{n_pending} unprocessed email(s) inside the rolling window (normal queue)"))

    # Emails received today
    today_rows = sb.table("raw_emails") \
        .select("id, subject, processed") \
        .gte("received_at", f"{date_str}T00:00:00Z") \
        .lte("received_at", f"{date_str}T23:59:59Z") \
        .execute()
    today_emails = today_rows.data or []
    total_today  = len(today_emails)
    processed_ct = sum(1 for e in today_emails if e.get("processed"))

    if total_today > 0:
        results.append(CheckResult(
            "pass", f"emails received ({date_str})",
            f"{total_today} fetched, {processed_ct}/{total_today} processed"
        ))
    else:
        recent = sb.table("raw_emails") \
            .select("received_at") \
            .order("received_at", desc=True) \
            .limit(1) \
            .execute()
        last = recent.data[0]["received_at"][:10] if recent.data else "never"
        results.append(CheckResult(
            "warn", f"emails received ({date_str})",
            f"0 emails today (most recent in DB: {last})"
        ))

    # Source registry
    sources = sb.table("sources").select("id, name, active").execute()
    all_srcs    = sources.data or []
    active_srcs = sum(1 for s in all_srcs if s.get("active", True))
    results.append(CheckResult(
        "info", "source registry",
        f"{active_srcs} active / {len(all_srcs)} total sources known"
    ))

    return results


# ── Stage 2: Article Parsing ───────────────────────────────────────────────────

def audit_article_parsing(target_date: date, lookback_days: int) -> list[CheckResult]:
    date_str = target_date.isoformat()
    results  = []

    today_rows = sb.table("articles") \
        .select("id, title, url, snippet, primary_category_id, category_tags") \
        .gte("published_at", f"{date_str}T00:00:00Z") \
        .lte("published_at", f"{date_str}T23:59:59Z") \
        .execute()
    arts = today_rows.data or []
    n    = len(arts)

    # Article count expectation
    if n >= 5:
        results.append(CheckResult("pass", f"articles extracted ({date_str})", f"{n} articles"))
    elif n > 0:
        results.append(CheckResult("warn", f"articles extracted ({date_str})",
                                   f"only {n} article(s) — lower than usual"))
    else:
        results.append(CheckResult("fail", f"articles extracted ({date_str})",
                                   "0 articles — extraction likely failed"))

    # Extraction quality checks (only meaningful if there's something to check)
    if arts:
        no_title    = sum(1 for a in arts if not (a.get("title") or "").strip())
        no_snippet  = sum(1 for a in arts if not (a.get("snippet") or "").strip())
        no_category = sum(1 for a in arts if not a.get("primary_category_id"))
        no_url      = sum(1 for a in arts if not a.get("url"))
        dupe_urls   = _duplicate_url_count(arts)

        quality_ok = not (no_title or no_snippet or no_category or dupe_urls)

        if quality_ok:
            results.append(CheckResult("pass", "extraction quality",
                                       "no missing titles/snippets/categories or duplicate URLs"))
        if no_title:
            results.append(CheckResult("warn", "quality — empty title",
                                       f"{no_title}/{n} articles ({_pct(no_title, n)})"))
        if no_snippet:
            results.append(CheckResult("warn", "quality — empty snippet",
                                       f"{no_snippet}/{n} articles ({_pct(no_snippet, n)})"))
        if no_category:
            results.append(CheckResult("warn", "quality — no category",
                                       f"{no_category}/{n} articles ({_pct(no_category, n)})"))
        if dupe_urls:
            results.append(CheckResult("warn", "quality — duplicate URLs",
                                       f"{dupe_urls} duplicate URL(s) across today's articles"))

        results.append(CheckResult(
            "info", "articles without URL",
            f"{no_url}/{n} ({_pct(no_url, n)}) — expected for digest-style newsletters"
        ))

    # Lookback: daily article counts
    start_str = (target_date - timedelta(days=lookback_days)).isoformat()
    hist = sb.table("articles") \
        .select("published_at") \
        .gte("published_at", f"{start_str}T00:00:00Z") \
        .lte("published_at", f"{date_str}T23:59:59Z") \
        .execute()

    daily: dict[str, int] = {}
    for a in (hist.data or []):
        d = a["published_at"][:10]
        daily[d] = daily.get(d, 0) + 1

    if daily:
        table = "  |  ".join(f"{d}: {c}" for d, c in sorted(daily.items()))
        results.append(CheckResult("info", f"articles/day (last {lookback_days}d)", table))

    return results


# ── Stage 3: Article Scoring ───────────────────────────────────────────────────

def audit_article_scoring(target_date: date) -> list[CheckResult]:
    date_str = target_date.isoformat()
    results  = []

    rows = sb.table("articles") \
        .select("id, title, impact_score, relevance_score, category_tags") \
        .gte("published_at", f"{date_str}T00:00:00Z") \
        .lte("published_at", f"{date_str}T23:59:59Z") \
        .execute()
    arts = rows.data or []

    if not arts:
        results.append(CheckResult("warn", "scoring", "no articles today — skipping score checks"))
        return results

    # Impact score checks
    impact_scores    = [a["impact_score"]    for a in arts if a.get("impact_score")    is not None]
    relevance_scores = [a["relevance_score"] for a in arts if a.get("relevance_score") is not None]

    null_impact   = len(arts) - len(impact_scores)
    null_relevance= len(arts) - len(relevance_scores)
    zero_impact   = sum(1 for s in impact_scores if s == 0.0)

    if null_impact:
        results.append(CheckResult("warn", "impact score — null",
                                   f"{null_impact}/{len(arts)} articles missing impact_score"))
    if zero_impact:
        results.append(CheckResult("warn", "impact score — zero",
                                   f"{zero_impact} articles have impact_score = 0.0 (check scoring pipeline)"))

    if impact_scores:
        dist   = _score_distribution(impact_scores)
        avg_i  = _avg(impact_scores)
        score_ok = not null_impact and not zero_impact
        results.append(CheckResult(
            "pass" if score_ok else "warn",
            "impact score distribution",
            f"min={min(impact_scores):.3f}  avg={avg_i}  max={max(impact_scores):.3f} | {dist}"
        ))

    if relevance_scores:
        avg_r       = _avg(relevance_scores)
        low_rel     = sum(1 for s in relevance_scores if s < 0.3)
        warn_rel    = null_relevance > 0 or low_rel > len(arts) // 3
        results.append(CheckResult(
            "warn" if warn_rel else "pass",
            "relevance score distribution",
            f"avg={avg_r}  low(<0.3)={low_rel}/{len(relevance_scores)}"
        ))

    # Cross-category coverage
    multi = sum(1 for a in arts if len(a.get("category_tags") or []) >= 2)
    results.append(CheckResult("info", "cross-category tags",
                               f"{multi}/{len(arts)} articles tagged with 2+ categories"))

    # Category breakdown
    cat_counts: dict[str, int] = {}
    for a in arts:
        tags = a.get("category_tags") or []
        for t in tags:
            cat_counts[t] = cat_counts.get(t, 0) + 1
    if cat_counts:
        breakdown = "  ".join(f"{k}={v}" for k, v in sorted(cat_counts.items()))
        results.append(CheckResult("info", "articles by category tag", breakdown))

    return results


# ── Stage 4: Summarization ─────────────────────────────────────────────────────

def audit_summarization(target_date: date, lookback_days: int) -> list[CheckResult]:
    date_str = target_date.isoformat()
    results  = []

    # Today's summaries
    today_rows = sb.table("daily_summaries") \
        .select("date, summary, article_count, category:categories(name)") \
        .eq("date", date_str) \
        .execute()
    today_sums = today_rows.data or []

    generated_cats = {s["category"]["name"] for s in today_sums if s.get("category")}
    missing_cats   = set(CATEGORIES) - generated_cats

    if not missing_cats:
        results.append(CheckResult("pass", f"daily summaries ({date_str})",
                                   f"all 5 categories generated"))
    elif missing_cats != set(CATEGORIES):
        results.append(CheckResult("warn", f"daily summaries ({date_str})",
                                   f"{len(generated_cats)}/5 generated | missing: {', '.join(sorted(missing_cats))}"))
    else:
        results.append(CheckResult("fail", f"daily summaries ({date_str})",
                                   "0/5 summaries generated — summarization step failed entirely"))

    # Per-summary quality
    for s in today_sums:
        text    = s.get("summary") or ""
        cat     = (s.get("category") or {}).get("name", "?")
        art_cnt = s.get("article_count") or 0
        if len(text) < 80:
            results.append(CheckResult("warn", f"summary quality — {cat}",
                                       f"suspiciously short ({len(text)} chars)"))
        elif art_cnt == 0:
            results.append(CheckResult("warn", f"summary quality — {cat}",
                                       "article_count=0 but summary exists"))
        else:
            results.append(CheckResult("pass", f"summary quality — {cat}",
                                       f"{len(text)} chars, {art_cnt} articles"))

    # Lookback: days with no summaries at all
    start_str = (target_date - timedelta(days=lookback_days)).isoformat()
    hist = sb.table("daily_summaries") \
        .select("date, category:categories(name)") \
        .gte("date", start_str) \
        .lte("date", date_str) \
        .execute()

    by_date: dict[str, set] = {}
    for s in (hist.data or []):
        d   = s["date"]
        cat = (s.get("category") or {}).get("name", "?")
        by_date.setdefault(d, set()).add(cat)

    gaps = []
    for i in range(1, lookback_days + 1):
        d = (target_date - timedelta(days=i)).isoformat()
        if not by_date.get(d):
            gaps.append(d)

    if gaps:
        results.append(CheckResult("warn", f"summary continuity (last {lookback_days}d)",
                                   f"no summaries on: {', '.join(gaps)}"))
    else:
        results.append(CheckResult("pass", f"summary continuity (last {lookback_days}d)",
                                   "summaries present on every recent day"))

    # Partial coverage days (have articles but only some categories summarised)
    partial = [d for d, cats in by_date.items() if 0 < len(cats) < 5]
    if partial:
        results.append(CheckResult("info", "partial-coverage days",
                                   f"{len(partial)} day(s) with <5 categories: {', '.join(sorted(partial))}"))

    return results


# ── Stage 5: Insight Distillation ────────────────────────────────────────────

def audit_insight_distillation(target_date: date, lookback_days: int) -> list[CheckResult]:
    date_str = target_date.isoformat()
    results  = []

    # Candidate insights created on the target date (still awaiting weekly
    # classification — filtered to status='candidate' so a weekly run that
    # has since reclassified some of these rows doesn't inflate the count).
    candidates = sb.table("insights") \
        .select("id, domains, status") \
        .eq("first_seen_at", date_str) \
        .eq("status", "candidate") \
        .execute()
    n_candidates = len(candidates.data or [])
    results.append(CheckResult(
        "info", f"candidate insights ({date_str})",
        f"{n_candidates} candidate(s) extracted"
    ))

    # Active insight count per domain
    active = sb.table("insights") \
        .select("domains") \
        .eq("status", "active") \
        .execute()
    domain_counts: dict[str, int] = {}
    for row in (active.data or []):
        for d in (row.get("domains") or []):
            domain_counts[d] = domain_counts.get(d, 0) + 1
    if domain_counts:
        breakdown = "  ".join(f"{k}={v}" for k, v in sorted(domain_counts.items()))
        results.append(CheckResult("info", "active insights by domain", breakdown))
    else:
        results.append(CheckResult("info", "active insights by domain", "none yet"))

    # Weekly job freshness
    last_weekly = sb.table("pipeline_runs") \
        .select("started_at, status, metadata") \
        .eq("job_name", "distill-insights") \
        .order("started_at", desc=True) \
        .limit(20) \
        .execute()
    weekly_runs = [r for r in (last_weekly.data or []) if (r.get("metadata") or {}).get("mode") == "weekly"]

    if not weekly_runs:
        results.append(CheckResult("info", "weekly distillation", "no weekly runs yet"))
    else:
        last_run = weekly_runs[0]
        last_date = date.fromisoformat(last_run["started_at"][:10])
        days_since = (target_date - last_date).days
        if days_since > 8:
            results.append(CheckResult("warn", "weekly distillation",
                                       f"last run {days_since}d ago ({last_run['status']}) — expected weekly"))
        else:
            results.append(CheckResult("pass", "weekly distillation",
                                       f"last run {days_since}d ago, status={last_run['status']}"))

    return results


# ── Main report ────────────────────────────────────────────────────────────────

STAGES = [
    ("Stage 1 — Email Fetch",         audit_email_fetch),
    ("Stage 2 — Article Parsing",     audit_article_parsing),
    ("Stage 3 — Article Scoring",     audit_article_scoring),
    ("Stage 4 — Summarization",       audit_summarization),
    ("Stage 5 — Insight Distillation", audit_insight_distillation),
]


def run_audit(target_date: date, lookback_days: int = 7, write_md: bool = False) -> bool:
    print(f"\n{BOLD}{'='*62}{RESET}")
    print(f"{BOLD}EJ Newsfeed Pipeline Audit — {target_date.isoformat()}{RESET}")
    print(f"{BOLD}{'='*62}{RESET}\n")

    all_results: list[tuple[str, list[CheckResult]]] = []

    for stage_name, audit_fn in STAGES:
        # Stages 2 & 4 accept a lookback_days argument; 1 & 3 do not
        try:
            checks = audit_fn(target_date, lookback_days)  # type: ignore[call-arg]
        except TypeError:
            checks = audit_fn(target_date)  # type: ignore[call-arg]

        all_results.append((stage_name, checks))

        print(f"{BOLD}{stage_name}{RESET}")
        for c in checks:
            print(c.render_console())
        print()

    # Overall verdict
    flat       = [c for _, checks in all_results for c in checks]
    fail_count = sum(1 for c in flat if c.status == "fail")
    warn_count = sum(1 for c in flat if c.status == "warn")

    print(f"{BOLD}{'─'*62}{RESET}")
    if fail_count:
        verdict = f"{RED}{BOLD}DEGRADED — {fail_count} failure(s), {warn_count} warning(s){RESET}"
    elif warn_count:
        verdict = f"{YELLOW}{BOLD}HEALTHY WITH WARNINGS — {warn_count} warning(s){RESET}"
    else:
        verdict = f"{GREEN}{BOLD}HEALTHY — all checks passed{RESET}"
    print(f"Overall: {verdict}\n")

    if write_md:
        _write_markdown(target_date, all_results, fail_count, warn_count)

    return fail_count > 0


def _write_markdown(
    target_date: date,
    all_results: list[tuple[str, list[CheckResult]]],
    fail_count: int,
    warn_count: int,
):
    overall = (
        "DEGRADED" if fail_count
        else "HEALTHY WITH WARNINGS" if warn_count
        else "HEALTHY"
    )
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    lines = [
        f"# EJ Newsfeed Pipeline Audit — {target_date.isoformat()}",
        "",
        f"> Generated: {now}  |  Overall: **{overall}**",
        "",
        "---",
        "",
    ]

    for stage_name, checks in all_results:
        lines += [
            f"## {stage_name}",
            "",
            "| Status | Check | Detail |",
            "|--------|-------|--------|",
        ]
        for c in checks:
            lines.append(c.render_md())
        lines.append("")

    lines += [
        "---",
        "",
        f"**Overall: {overall}** — {fail_count} failure(s), {warn_count} warning(s)",
    ]

    out_path = os.path.join(
        os.path.dirname(__file__),
        f"../pipeline-audit-{target_date.isoformat()}.md",
    )
    out_path = os.path.normpath(out_path)
    with open(out_path, "w") as fh:
        fh.write("\n".join(lines) + "\n")
    print(f"{DIM}Markdown report written to {out_path}{RESET}")


# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="EJ Newsfeed end-to-end pipeline audit"
    )
    parser.add_argument(
        "--date", default=date.today().isoformat(),
        help="Target date to audit (YYYY-MM-DD, default: today)"
    )
    parser.add_argument(
        "--days", type=int, default=7,
        help="Lookback window in days for trend checks (default: 7)"
    )
    parser.add_argument(
        "--md", action="store_true",
        help="Write a markdown audit report alongside the console output"
    )
    args = parser.parse_args()

    target   = date.fromisoformat(args.date)
    degraded = run_audit(target, lookback_days=args.days, write_md=args.md)
    sys.exit(1 if degraded else 0)
