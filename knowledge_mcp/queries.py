"""Pure query-filter and response-shaping logic for the knowledge MCP server.

No I/O — every function takes plain data and returns plain data, so it is
unit-testable without a database.
"""

DEFAULT_INSIGHT_STATUS = ["active", "contested"]


def insight_status_filter(status):
    """Statuses to query for insights; default to active + contested."""
    return status if status else DEFAULT_INSIGHT_STATUS


def ilike_pattern(query):
    """Build an ILIKE substring pattern, or None when there's no query."""
    if not query:
        return None
    return f"%{query}%"


def shape_insight(row):
    return {
        "id": row["id"],
        "text": row["text"],
        "domains": row.get("domains") or [],
        "confidence": row.get("confidence"),
        "status": row["status"],
        "first_seen_at": row.get("first_seen_at"),
        "last_confirmed_at": row.get("last_confirmed_at"),
    }


def _shape_source(source_row):
    article = source_row.get("article") or {}
    return {
        "title": article.get("title"),
        "url": article.get("url"),
        "source": (article.get("source") or {}).get("name"),
    }


def split_sources(source_rows):
    """Split embedded insight_sources rows into (supporting, contradicting)."""
    supporting, contradicting = [], []
    for row in source_rows or []:
        item = _shape_source(row)
        if row.get("relation") == "supporting":
            supporting.append(item)
        elif row.get("relation") == "contradicting":
            contradicting.append(item)
    return supporting, contradicting


def shape_contested(insight_row):
    """Shape a contested insight that carries embedded `insight_sources`."""
    supporting, contradicting = split_sources(insight_row.get("insight_sources"))
    return {
        "id": insight_row["id"],
        "text": insight_row["text"],
        "domains": insight_row.get("domains") or [],
        "confidence": insight_row.get("confidence"),
        "supporting": supporting,
        "contradicting": contradicting,
    }


def shape_insight_with_sources(insight_row, source_rows):
    """Full insight shape plus its supporting/contradicting sources."""
    supporting, contradicting = split_sources(source_rows)
    out = shape_insight(insight_row)
    out["supporting"] = supporting
    out["contradicting"] = contradicting
    return out


def shape_open_question(row):
    return {
        "id": row["id"],
        "question": row["question"],
        "why_it_matters": row.get("why_it_matters"),
        "domains": row.get("domains") or [],
        "status": row["status"],
    }


def shape_decision(row):
    return {
        "id": row["id"],
        "text": row["text"],
        "context": row.get("context"),
        "domains": row.get("domains") or [],
        "decided_at": row.get("decided_at"),
        "status": row["status"],
    }


def shape_hypothesis(row, evidence_rows=None):
    for_, against = [], []
    for ev in evidence_rows or []:
        text = (ev.get("insight") or {}).get("text")
        if ev.get("stance") == "for":
            for_.append(text)
        elif ev.get("stance") == "against":
            against.append(text)
    return {
        "id": row["id"],
        "statement": row["statement"],
        "domains": row.get("domains") or [],
        "status": row["status"],
        "evidence": {"for": for_, "against": against},
    }


def consolidate_knowledge(topic, insights, open_questions, decisions, hypotheses):
    return {
        "topic": topic,
        "insights": insights,
        "open_questions": open_questions,
        "decisions": decisions,
        "hypotheses": hypotheses,
    }
