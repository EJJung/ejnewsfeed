#!/usr/bin/env python3
"""
prune_audits.py — retention policy for daily pipeline audit reports.

Daily reports (pipeline-audit-YYYY-MM-DD.md, repo root) older than
RETENTION_DAYS are rolled up into a monthly trend report
(pipeline-audit-trend-YYYY-MM.md) and then deleted. Matching log files
(logs/audit-YYYY-MM-DD.log) older than the cutoff are deleted too.

The rollup is incremental and idempotent: each month's trend report keeps
one table row per day, and re-running never loses rows that were already
recorded. Days are pruned as they cross the 30-day line, so a month's
trend report fills in gradually until the whole month has aged out.

Usage:
    python3 prune_audits.py             # prune + roll up
    python3 prune_audits.py --dry-run   # show what would happen
    python3 prune_audits.py --days 30   # override retention window
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from datetime import date, datetime, timedelta, timezone

RETENTION_DAYS = 30

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.normpath(os.path.join(SCRIPT_DIR, ".."))
LOG_DIR = os.path.join(REPO_ROOT, "logs")

DAILY_RE = re.compile(r"^pipeline-audit-(\d{4}-\d{2}-\d{2})\.md$")
LOG_RE = re.compile(r"^audit-(\d{4}-\d{2}-\d{2})\.log$")
TREND_ROW_RE = re.compile(r"^\|\s*(\d{4}-\d{2}-\d{2})\s*\|(.*)\|\s*$")


# ── Parsing daily reports ─────────────────────────────────────────────────────

def parse_daily_report(path: str, day: str) -> dict:
    """Extract trend metrics from one daily audit report. Missing metrics
    stay None — the trend table renders those as an em-dash."""
    with open(path, encoding="utf-8") as fh:
        text = fh.read()

    row: dict = {"date": day, "overall": None, "fails": None, "warns": None,
                 "backlog": None, "emails": None, "articles": None,
                 "summaries": None}

    m = re.search(r"Overall:\s*\*{0,2}(HEALTHY WITH WARNINGS|HEALTHY|DEGRADED)\*{0,2}", text)
    if m:
        row["overall"] = m.group(1)

    m = re.search(r"(\d+)\s+failure\(s\),\s*(\d+)\s+warning\(s\)", text)
    if m:
        row["fails"], row["warns"] = int(m.group(1)), int(m.group(2))

    # Backlog — old format ("998 emails stuck"), new stuck-vs-pending format,
    # and the freeform "0 unprocessed emails" wording, in that order.
    for pat in (r"(\d+)\s+emails? stuck",
                r"(\d+)\s+emails?(?:\(s\))?\s+(?:outside|fell outside)\s+the 72h",
                r"(\d+)\s+unprocessed emails?"):
        m = re.search(pat, text)
        if m:
            row["backlog"] = int(m.group(1))
            break

    m = re.search(r"(\d+)\s+fetched,\s*\d+/\d+\s+processed", text)
    if m:
        row["emails"] = int(m.group(1))
    elif re.search(r"0 emails today", text):
        row["emails"] = 0

    m = re.search(r"articles extracted[^|]*\|\s*\*{0,2}(?:only\s+)?(\d+)\s+articles?", text)
    if m:
        row["articles"] = int(m.group(1))
    elif re.search(r"articles extracted[^|]*\|\s*0 articles", text):
        row["articles"] = 0

    m = (re.search(r"daily summaries[^|]*\|\s*\*{0,2}(\d+)/(\d+)", text)
         or re.search(r"(\d+)/(\d+)\s+summar", text))
    if m:
        row["summaries"] = f"{m.group(1)}/{m.group(2)}"
    else:
        m = re.search(r"daily summaries[^|]*\|\s*\*{0,2}all\s+(\d+)\s+categories generated", text)
        if m:
            row["summaries"] = f"{m.group(1)}/{m.group(1)}"

    return row


# ── Trend report read / write ─────────────────────────────────────────────────

def _cell(v) -> str:
    return "—" if v is None else str(v)

def _num(cell: str):
    cell = cell.strip()
    return int(cell) if cell.isdigit() else None

def read_trend_rows(path: str) -> dict:
    """Parse the daily-history table of an existing trend report back into
    row dicts keyed by date, so rollups merge instead of overwrite."""
    rows: dict = {}
    if not os.path.exists(path):
        return rows
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            m = TREND_ROW_RE.match(line.rstrip())
            if not m:
                continue
            cells = [c.strip() for c in m.group(2).split("|")]
            if len(cells) != 7:
                continue
            overall = cells[0].strip() or None
            rows[m.group(1)] = {
                "date": m.group(1),
                "overall": None if overall in (None, "—") else overall,
                "fails": _num(cells[1]),
                "warns": _num(cells[2]),
                "backlog": _num(cells[3]),
                "emails": _num(cells[4]),
                "articles": _num(cells[5]),
                "summaries": None if cells[6] in ("", "—") else cells[6],
            }
    return rows


def write_trend_report(path: str, month: str, rows: dict) -> None:
    ordered = [rows[d] for d in sorted(rows)]
    n = len(ordered)

    def count(status):
        return sum(1 for r in ordered if r["overall"] == status)

    backlogs = [(r["date"], r["backlog"]) for r in ordered if r["backlog"] is not None]
    articles = [r["articles"] for r in ordered if r["articles"] is not None]
    fails = [r["fails"] for r in ordered if r["fails"] is not None]
    warns = [r["warns"] for r in ordered if r["warns"] is not None]
    sums_full = sum(1 for r in ordered if r["summaries"] and "/" in r["summaries"]
                    and r["summaries"].split("/")[0] == r["summaries"].split("/")[1])
    sums_none = sum(1 for r in ordered if r["summaries"] and r["summaries"].startswith("0/"))

    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [
        f"# EJ Newsfeed Pipeline Audit Trend — {month}",
        "",
        f"> Monthly rollup of daily audit reports (dailies are pruned after {RETENTION_DAYS} days).",
        f"> Last updated: {now}  |  Days recorded: {n}",
        "",
        "## Month at a glance",
        "",
        f"- **Overall:** {count('HEALTHY')} healthy · "
        f"{count('HEALTHY WITH WARNINGS')} healthy-with-warnings · "
        f"{count('DEGRADED')} degraded (of {n} audited days)",
    ]
    if fails:
        lines.append(f"- **Failures:** {sum(fails)} total, avg {sum(fails)/len(fails):.1f}/day"
                     f" · **Warnings:** {sum(warns) if warns else 0} total")
    if backlogs:
        vals = [b for _, b in backlogs]
        lines.append(f"- **Backlog:** {backlogs[0][1]} ({backlogs[0][0]}) → "
                     f"{backlogs[-1][1]} ({backlogs[-1][0]})  ·  min {min(vals)} / max {max(vals)}")
    if articles:
        lines.append(f"- **Articles extracted:** {sum(articles)} total · "
                     f"{sum(1 for a in articles if a == 0)} day(s) with zero extraction")
    lines.append(f"- **Summaries:** {sums_full} day(s) complete · {sums_none} day(s) with none")
    lines += [
        "",
        "## Daily history",
        "",
        "| Date | Overall | Fail | Warn | Backlog | Emails | Articles | Summaries |",
        "|------|---------|-----:|-----:|--------:|-------:|---------:|----------:|",
    ]
    for r in ordered:
        lines.append(
            f"| {r['date']} | {_cell(r['overall'])} | {_cell(r['fails'])} | "
            f"{_cell(r['warns'])} | {_cell(r['backlog'])} | {_cell(r['emails'])} | "
            f"{_cell(r['articles'])} | {_cell(r['summaries'])} |"
        )
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description="Prune old daily audit reports into monthly trend rollups")
    ap.add_argument("--days", type=int, default=RETENTION_DAYS,
                    help=f"retention window in days (default: {RETENTION_DAYS})")
    ap.add_argument("--dry-run", action="store_true",
                    help="report what would be rolled up/deleted without changing anything")
    ap.add_argument("--root", default=REPO_ROOT, help=argparse.SUPPRESS)
    args = ap.parse_args()

    root = os.path.abspath(args.root)
    log_dir = os.path.join(root, "logs")
    cutoff = date.today() - timedelta(days=args.days)
    prefix = "[dry-run] " if args.dry_run else ""

    # 1. Collect daily reports past the cutoff, grouped by month.
    by_month: dict = {}
    for name in sorted(os.listdir(root)):
        m = DAILY_RE.match(name)
        if not m:
            continue
        try:
            d = date.fromisoformat(m.group(1))
        except ValueError:
            continue
        if d < cutoff:
            by_month.setdefault(m.group(1)[:7], []).append((m.group(1), os.path.join(root, name)))

    # 2. Roll up, then delete.
    pruned = 0
    for month, files in sorted(by_month.items()):
        trend_path = os.path.join(root, f"pipeline-audit-trend-{month}.md")
        rows = read_trend_rows(trend_path)
        for day, path in files:
            rows[day] = parse_daily_report(path, day)
        if not args.dry_run:
            write_trend_report(trend_path, month, rows)
        print(f"{prefix}trend {os.path.basename(trend_path)}: "
              f"{len(files)} day(s) rolled up, {len(rows)} total")
        for day, path in files:
            if not args.dry_run:
                os.remove(path)
            print(f"{prefix}  deleted {os.path.basename(path)}")
            pruned += 1

    # 3. Old audit logs.
    logs_pruned = 0
    if os.path.isdir(log_dir):
        for name in sorted(os.listdir(log_dir)):
            m = LOG_RE.match(name)
            if not m:
                continue
            try:
                d = date.fromisoformat(m.group(1))
            except ValueError:
                continue
            if d < cutoff:
                if not args.dry_run:
                    os.remove(os.path.join(log_dir, name))
                print(f"{prefix}deleted logs/{name}")
                logs_pruned += 1

    print(f"{prefix}done: {pruned} report(s) and {logs_pruned} log(s) pruned "
          f"(cutoff {cutoff.isoformat()}, {args.days}-day retention)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
