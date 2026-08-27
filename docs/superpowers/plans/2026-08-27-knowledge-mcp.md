# Knowledge Layer MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local stdio MCP server exposing the ejnewsfeed knowledge layer to Claude Code skills as 7 read-only query tools.

**Architecture:** Python package `knowledge_mcp/` run as `-m knowledge_mcp.server`. `server.py` (thin `FastMCP` tool layer) → `queries.py` (pure, unit-tested shaping/filter logic) + `db.py` (thin `supabase-py` reads with the `service_role` key). Read-only by construction — no write tools, only SELECTs.

**Tech Stack:** Python 3.14 (project `.venv`), `mcp` SDK (`FastMCP`), `supabase-py` 2.30, `python-dotenv`, `pytest`.

## Global Constraints

- Package is `knowledge_mcp/` (NOT `mcp/` — that would shadow the `mcp` SDK). Run as `-m knowledge_mcp.server` from repo root; internal imports are absolute (`from knowledge_mcp import db, queries`).
- All commands run from repo root `/Users/ejjung/Dev/ejnewsfeed` using `.venv/bin/python` and `.venv/bin/pip`.
- Read-only: no `.insert(`/`.update(`/`.delete(`/`.upsert(` anywhere under `knowledge_mcp/`. No write tools.
- Key: `service_role`, loaded via `python-dotenv` from `knowledge_mcp/.env` (gitignored; values copied from `pipeline/.env`). Never commit the key.
- Supabase reads use the `supabase-py` builder: `client.table(name).select(...).in_(...).eq(...).ilike(col, '%q%').overlaps('domains', [...]).order(...).limit(...).execute().data`. All these methods are verified present.
- Domain vocabulary: `ai, it, entrepreneurship, business, ux`. Domain filter = array **overlap** (`.overlaps('domains', domains)`).
- Embedded-resource select syntax (mirrors the dashboard's `KnowledgeView.jsx`): `insight_sources` sources → `select('relation, article:articles(title, url, source:sources(name))')`; hypothesis evidence → `select('stance, insight:insights(text)')`.
- The 7 tools and their exact I/O are defined in `docs/superpowers/specs/2026-08-26-knowledge-mcp-design.md` — follow it verbatim.

---

### Task 1: Package scaffold, dependencies, env, DB client

Create the package, install deps, wire the env-configured Supabase client, and prove connectivity.

**Files:**
- Create: `knowledge_mcp/__init__.py`
- Create: `knowledge_mcp/requirements.txt`
- Create: `knowledge_mcp/.env.example`
- Create: `knowledge_mcp/db.py`
- Modify: `.gitignore` (only if `knowledge_mcp/.env` isn't already ignored — verified it IS, so likely no change)

**Interfaces:**
- Produces: `knowledge_mcp.db.get_client() -> supabase.Client` (lazily created, cached; loads `knowledge_mcp/.env`).

- [ ] **Step 1: Create the package marker and requirements**

Create `knowledge_mcp/__init__.py` (empty file).

Create `knowledge_mcp/requirements.txt`:
```
mcp>=1.2.0
supabase>=2.3.0
python-dotenv>=1.0.0
```

Create `knowledge_mcp/.env.example`:
```
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

- [ ] **Step 2: Install the mcp SDK into the venv**

`supabase` and `python-dotenv` are already installed; only `mcp` is missing. Run from repo root:
```bash
.venv/bin/pip install "mcp>=1.2.0"
```
Expected: installs `mcp` and its deps. Verify:
```bash
.venv/bin/python -c "from mcp.server.fastmcp import FastMCP; print('FastMCP ok')"
```
Expected: `FastMCP ok`.

- [ ] **Step 3: Create the local .env from pipeline's**

Copy the two needed vars from the existing `pipeline/.env` (which has the service_role key). Run from repo root:
```bash
grep -E '^(SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY)=' pipeline/.env > knowledge_mcp/.env
```
Verify it's gitignored (must print the path):
```bash
git check-ignore knowledge_mcp/.env
```
Expected: `knowledge_mcp/.env`. If it does NOT print, add `knowledge_mcp/.env` to `.gitignore` before continuing.

- [ ] **Step 4: Write db.get_client()**

Create `knowledge_mcp/db.py`:
```python
"""Thin Supabase access for the knowledge MCP server (read-only)."""
import os
from pathlib import Path

from dotenv import load_dotenv
from supabase import create_client, Client

_client: Client | None = None


def get_client() -> Client:
    """Return a cached Supabase client, configured from knowledge_mcp/.env."""
    global _client
    if _client is None:
        load_dotenv(Path(__file__).parent / ".env")
        url = os.environ["SUPABASE_URL"]
        key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        _client = create_client(url, key)
    return _client
```

- [ ] **Step 5: Verify connectivity (live)**

Run from repo root:
```bash
.venv/bin/python -c "from knowledge_mcp.db import get_client; print(len(get_client().table('insights').select('id').limit(1).execute().data), 'row(s) reachable')"
```
Expected: `1 row(s) reachable` (insights is populated). This confirms the package imports, env loads, and the service_role client reads.

- [ ] **Step 6: Commit**

```bash
git add knowledge_mcp/__init__.py knowledge_mcp/requirements.txt knowledge_mcp/.env.example knowledge_mcp/db.py
git commit -m "feat: scaffold knowledge_mcp package + supabase client"
```
(Do NOT add `knowledge_mcp/.env` — it's gitignored.)

---

### Task 2: Pure query/shaping logic (`queries.py`) — TDD

All pure functions: filter-argument construction and row→response shaping. No I/O. This is the heart of the server and gets full unit tests.

**Files:**
- Create: `knowledge_mcp/queries.py`
- Test: `knowledge_mcp/tests/__init__.py`, `knowledge_mcp/tests/test_queries.py`

**Interfaces:**
- Produces (all pure):
  - `insight_status_filter(status: list[str] | None) -> list[str]` — returns `status` or `["active","contested"]`.
  - `ilike_pattern(query: str | None) -> str | None` — `None`/empty → `None`; else `f"%{query}%"`.
  - `shape_insight(row: dict) -> dict` — `{id, text, domains, confidence, status, first_seen_at, last_confirmed_at}`.
  - `split_sources(source_rows: list[dict]) -> tuple[list, list]` — `(supporting, contradicting)`, each item `{title, url, source}`.
  - `shape_contested(insight_row: dict) -> dict` — `{id, text, domains, confidence, supporting, contradicting}` (reads embedded `insight_sources`).
  - `shape_insight_with_sources(insight_row: dict, source_rows: list[dict]) -> dict` — full insight + `supporting`/`contradicting`.
  - `shape_open_question(row) -> dict`, `shape_decision(row) -> dict`.
  - `shape_hypothesis(row: dict, evidence_rows: list[dict] | None = None) -> dict` — `{..., evidence: {for, against}}`.
  - `consolidate_knowledge(topic, insights, open_questions, decisions, hypotheses) -> dict`.

- [ ] **Step 1: Write the failing tests**

Create `knowledge_mcp/tests/__init__.py` (empty).

Create `knowledge_mcp/tests/test_queries.py`:
```python
from knowledge_mcp import queries as q


def test_insight_status_filter_defaults():
    assert q.insight_status_filter(None) == ["active", "contested"]
    assert q.insight_status_filter([]) == ["active", "contested"]


def test_insight_status_filter_passthrough():
    assert q.insight_status_filter(["candidate"]) == ["candidate"]


def test_ilike_pattern():
    assert q.ilike_pattern(None) is None
    assert q.ilike_pattern("") is None
    assert q.ilike_pattern("agent pricing") == "%agent pricing%"


def test_shape_insight():
    row = {
        "id": "i1", "text": "X", "domains": ["ai"], "confidence": 0.8,
        "status": "active", "first_seen_at": "2026-08-01",
        "last_confirmed_at": "2026-08-10", "superseded_by": None,
    }
    assert q.shape_insight(row) == {
        "id": "i1", "text": "X", "domains": ["ai"], "confidence": 0.8,
        "status": "active", "first_seen_at": "2026-08-01",
        "last_confirmed_at": "2026-08-10",
    }


def test_shape_insight_missing_domains():
    row = {"id": "i1", "text": "X", "domains": None, "confidence": 0.5, "status": "active"}
    out = q.shape_insight(row)
    assert out["domains"] == []
    assert out["first_seen_at"] is None


def _src(relation, title):
    return {"relation": relation, "article": {"title": title, "url": f"http://x/{title}",
            "source": {"name": "Src"}}}


def test_split_sources():
    rows = [_src("supporting", "a"), _src("contradicting", "b"), _src("supporting", "c")]
    supporting, contradicting = q.split_sources(rows)
    assert [s["title"] for s in supporting] == ["a", "c"]
    assert [s["title"] for s in contradicting] == ["b"]
    assert supporting[0] == {"title": "a", "url": "http://x/a", "source": "Src"}


def test_split_sources_handles_null_article():
    rows = [{"relation": "supporting", "article": None}]
    supporting, contradicting = q.split_sources(rows)
    assert supporting == [{"title": None, "url": None, "source": None}]


def test_shape_contested_reads_embedded_sources():
    row = {"id": "i1", "text": "X", "domains": ["ai"], "confidence": 0.6,
           "insight_sources": [_src("supporting", "a"), _src("contradicting", "b")]}
    out = q.shape_contested(row)
    assert out["id"] == "i1"
    assert [s["title"] for s in out["supporting"]] == ["a"]
    assert [s["title"] for s in out["contradicting"]] == ["b"]
    assert "status" not in out


def test_shape_insight_with_sources():
    insight = {"id": "i1", "text": "X", "domains": ["ai"], "confidence": 0.6, "status": "contested"}
    out = q.shape_insight_with_sources(insight, [_src("supporting", "a")])
    assert out["status"] == "contested"
    assert out["supporting"][0]["title"] == "a"
    assert out["contradicting"] == []


def test_shape_open_question_and_decision():
    oq = {"id": "q1", "question": "Q?", "why_it_matters": "because", "domains": ["ux"], "status": "open"}
    assert q.shape_open_question(oq) == {"id": "q1", "question": "Q?",
        "why_it_matters": "because", "domains": ["ux"], "status": "open"}
    d = {"id": "d1", "text": "Do X", "context": "ctx", "domains": ["business"],
         "decided_at": "2026-08-01", "status": "standing"}
    assert q.shape_decision(d) == {"id": "d1", "text": "Do X", "context": "ctx",
        "domains": ["business"], "decided_at": "2026-08-01", "status": "standing"}


def test_shape_hypothesis_with_evidence():
    row = {"id": "h1", "statement": "S", "domains": ["ai"], "status": "open"}
    ev = [{"stance": "for", "insight": {"text": "supports"}},
          {"stance": "against", "insight": {"text": "refutes"}}]
    out = q.shape_hypothesis(row, ev)
    assert out["evidence"] == {"for": ["supports"], "against": ["refutes"]}


def test_shape_hypothesis_no_evidence():
    row = {"id": "h1", "statement": "S", "domains": ["ai"], "status": "open"}
    out = q.shape_hypothesis(row)
    assert out["evidence"] == {"for": [], "against": []}


def test_consolidate_knowledge_shape():
    out = q.consolidate_knowledge("topic", [1], [], [], [])
    assert out == {"topic": "topic", "insights": [1],
                   "open_questions": [], "decisions": [], "hypotheses": []}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
.venv/bin/python -m pytest knowledge_mcp/tests/test_queries.py -q
```
Expected: FAIL — `ModuleNotFoundError: No module named 'knowledge_mcp.queries'` (or collection error). If `pytest` is missing, install it: `.venv/bin/pip install pytest`.

- [ ] **Step 3: Implement queries.py**

Create `knowledge_mcp/queries.py`:
```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
.venv/bin/python -m pytest knowledge_mcp/tests/test_queries.py -q
```
Expected: PASS — all tests green, output clean.

- [ ] **Step 5: Commit**

```bash
git add knowledge_mcp/queries.py knowledge_mcp/tests/__init__.py knowledge_mcp/tests/test_queries.py
git commit -m "feat: add pure query/shaping logic for knowledge_mcp (+ unit tests)"
```

---

### Task 3: DB fetch functions (`db.py`)

Add the actual Supabase reads each tool needs. Thin — one function per read, filters applied via the supabase-py builder.

**Files:**
- Modify: `knowledge_mcp/db.py`

**Interfaces:**
- Consumes: `get_client()` (Task 1).
- Produces (each returns `list[dict]`, or the single-insight helper returns `dict | None`):
  - `fetch_insights(status: list[str], domains: list[str] | None, pattern: str | None, limit: int)`
  - `fetch_insight(insight_id: str) -> dict | None`
  - `fetch_insight_sources(insight_id: str)` — rows `{relation, article:{title,url,source:{name}}}`
  - `fetch_contested(domains: list[str] | None)` — insights with status contested + embedded `insight_sources`
  - `fetch_open_questions(status: str, domains: list[str] | None)`
  - `fetch_decisions(status: str, domains: list[str] | None)`
  - `fetch_hypotheses(status: str, domains: list[str] | None)`
  - `fetch_hypothesis_evidence(hypothesis_id: str)` — rows `{stance, insight:{text}}`

- [ ] **Step 1: Append the fetch functions to db.py**

Append to `knowledge_mcp/db.py`:
```python
INSIGHT_COLS = "id, text, domains, confidence, status, first_seen_at, last_confirmed_at"
SOURCE_SELECT = "relation, article:articles(title, url, source:sources(name))"


def fetch_insights(status, domains, pattern, limit):
    q = get_client().table("insights").select(INSIGHT_COLS).in_("status", status)
    if pattern:
        q = q.ilike("text", pattern)
    if domains:
        q = q.overlaps("domains", domains)
    return q.order("first_seen_at", desc=True).limit(limit).execute().data


def fetch_insight(insight_id):
    rows = get_client().table("insights").select(INSIGHT_COLS).eq("id", insight_id).execute().data
    return rows[0] if rows else None


def fetch_insight_sources(insight_id):
    return (
        get_client().table("insight_sources").select(SOURCE_SELECT)
        .eq("insight_id", insight_id).execute().data
    )


def fetch_contested(domains):
    q = (
        get_client().table("insights")
        .select(f"id, text, domains, confidence, insight_sources({SOURCE_SELECT})")
        .eq("status", "contested")
    )
    if domains:
        q = q.overlaps("domains", domains)
    return q.execute().data


def fetch_open_questions(status, domains):
    q = get_client().table("open_questions").select(
        "id, question, why_it_matters, domains, status").eq("status", status)
    if domains:
        q = q.overlaps("domains", domains)
    return q.execute().data


def fetch_decisions(status, domains):
    q = get_client().table("decisions").select(
        "id, text, context, domains, decided_at, status").eq("status", status)
    if domains:
        q = q.overlaps("domains", domains)
    return q.execute().data


def fetch_hypotheses(status, domains):
    q = get_client().table("hypotheses").select(
        "id, statement, domains, status").eq("status", status)
    if domains:
        q = q.overlaps("domains", domains)
    return q.execute().data


def fetch_hypothesis_evidence(hypothesis_id):
    return (
        get_client().table("hypothesis_evidence").select("stance, insight:insights(text)")
        .eq("hypothesis_id", hypothesis_id).execute().data
    )
```

- [ ] **Step 2: Verify live — insights read + embedded sources**

Run from repo root (this exercises the trickiest reads — the embedded article join and a contested insight):
```bash
.venv/bin/python -c "
from knowledge_mcp import db
ins = db.fetch_insights(['active','contested'], None, None, 3)
print('insights:', len(ins), '| sample keys:', sorted(ins[0].keys()) if ins else 'none')
con = db.fetch_contested(None)
print('contested:', len(con), '| has embedded sources:', ('insight_sources' in con[0]) if con else 'n/a')
print('empty tables ok:', db.fetch_decisions('standing', None), db.fetch_open_questions('open', None))
"
```
Expected: `insights: 3` with the seven insight columns as keys; `contested:` a non-negative count and (if any contested exist) `insight_sources` present; the two empty tables print `[] []`.

- [ ] **Step 3: Commit**

```bash
git add knowledge_mcp/db.py
git commit -m "feat: add knowledge_mcp DB fetch functions"
```

---

### Task 4: MCP server + 7 tools (`server.py`) + live smoke

Wire the tools with `FastMCP`, each calling `db` + `queries`. Add `smoke.py` that invokes every tool against real Supabase and prove it end-to-end.

**Files:**
- Create: `knowledge_mcp/server.py`
- Create: `knowledge_mcp/smoke.py`

**Interfaces:**
- Consumes: everything in `db.py` and `queries.py`.
- Produces: the 7 tool functions (plain, directly callable — `FastMCP`'s `@mcp.tool()` returns the original function) and `mcp` (the `FastMCP` instance). `python -m knowledge_mcp.server` starts the stdio server.

- [ ] **Step 1: Write server.py**

Create `knowledge_mcp/server.py`:
```python
"""Knowledge Layer MCP server — read-only query tools over the ejnewsfeed
knowledge layer, for local Claude Code skills. Run: python -m knowledge_mcp.server
"""
from mcp.server.fastmcp import FastMCP

from knowledge_mcp import db, queries

mcp = FastMCP("knowledge")


@mcp.tool()
def search_insights(query: str | None = None, domains: list[str] | None = None,
                    status: list[str] | None = None, limit: int = 20) -> list[dict]:
    """Search insights by topic text (case-insensitive substring), filtered by
    domain and status. status defaults to active + contested."""
    rows = db.fetch_insights(
        queries.insight_status_filter(status), domains, queries.ilike_pattern(query), limit)
    return [queries.shape_insight(r) for r in rows]


@mcp.tool()
def get_contested(domains: list[str] | None = None) -> list[dict]:
    """Contested insights with their supporting vs contradicting sources."""
    return [queries.shape_contested(r) for r in db.fetch_contested(domains)]


@mcp.tool()
def knowledge_query(topic: str, domains: list[str] | None = None) -> dict:
    """What do we know about a topic: matching insights, open questions,
    decisions, and hypotheses in one consolidated result."""
    pattern = queries.ilike_pattern(topic)
    insights = [queries.shape_insight(r)
                for r in db.fetch_insights(queries.insight_status_filter(None), domains, pattern, 20)]
    oqs = [queries.shape_open_question(r) for r in db.fetch_open_questions("open", domains)
           if pattern is None or (topic.lower() in (r.get("question") or "").lower())]
    decs = [queries.shape_decision(r) for r in db.fetch_decisions("standing", domains)
            if pattern is None or (topic.lower() in (r.get("text") or "").lower())]
    hyps = [queries.shape_hypothesis(r) for r in db.fetch_hypotheses("open", domains)
            if pattern is None or (topic.lower() in (r.get("statement") or "").lower())]
    return queries.consolidate_knowledge(topic, insights, oqs, decs, hyps)


@mcp.tool()
def get_insight_sources(insight_id: str) -> dict:
    """A specific insight plus its full supporting/contradicting source list."""
    insight = db.fetch_insight(insight_id)
    if insight is None:
        return {"error": "insight not found"}
    return queries.shape_insight_with_sources(insight, db.fetch_insight_sources(insight_id))


@mcp.tool()
def get_open_questions(domains: list[str] | None = None, status: str = "open") -> list[dict]:
    """Open questions (default status 'open'), optionally filtered by domain."""
    return [queries.shape_open_question(r) for r in db.fetch_open_questions(status, domains)]


@mcp.tool()
def get_decisions(domains: list[str] | None = None, status: str = "standing") -> list[dict]:
    """Recorded decisions (default status 'standing'), optionally by domain."""
    return [queries.shape_decision(r) for r in db.fetch_decisions(status, domains)]


@mcp.tool()
def get_hypotheses(domains: list[str] | None = None, status: str = "open") -> list[dict]:
    """Hypotheses (default status 'open') with their for/against evidence."""
    out = []
    for row in db.fetch_hypotheses(status, domains):
        evidence = db.fetch_hypothesis_evidence(row["id"])
        out.append(queries.shape_hypothesis(row, evidence))
    return out


if __name__ == "__main__":
    mcp.run()
```

Note: `knowledge_query` filters the (currently empty) open_questions/decisions/hypotheses in Python by substring on their text field, since those tables lack a single searchable column the DB helper filters on. Insights are filtered at the DB via `ilike`.

- [ ] **Step 2: Write smoke.py**

Create `knowledge_mcp/smoke.py`:
```python
"""Live smoke test: invoke every knowledge MCP tool against real Supabase.
Run: python -m knowledge_mcp.smoke
"""
import json

from knowledge_mcp import server as s


def _show(name, result):
    n = len(result) if isinstance(result, list) else 1
    print(f"\n=== {name} -> {n} item(s) ===")
    print(json.dumps(result, indent=2, default=str)[:800])


def main():
    _show("search_insights('ai', limit=3)", s.search_insights(query=None, domains=["ai"], limit=3))
    contested = s.get_contested()
    _show("get_contested()", contested)
    _show("knowledge_query('agent')", s.knowledge_query("agent"))
    _show("get_open_questions()", s.get_open_questions())
    _show("get_decisions()", s.get_decisions())
    _show("get_hypotheses()", s.get_hypotheses())
    # Exercise get_insight_sources on a real contested insight if one exists,
    # else on the first insight from a broad search.
    seed = contested[0]["id"] if contested else (
        s.search_insights(limit=1)[0]["id"] if s.search_insights(limit=1) else None)
    if seed:
        _show(f"get_insight_sources({seed})", s.get_insight_sources(seed))
    _show("get_insight_sources('00000000-0000-0000-0000-000000000000')",
          s.get_insight_sources("00000000-0000-0000-0000-000000000000"))
    print("\nSMOKE OK")


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Run the smoke test (live)**

```bash
.venv/bin/python -m knowledge_mcp.smoke
```
Expected: prints results for all 7 tools and ends with `SMOKE OK`. `search_insights`/`get_contested`/`knowledge_query` show real insight data; `get_open_questions`/`get_decisions`/`get_hypotheses` show `0 item(s)` (tables empty); `get_insight_sources(<real id>)` shows split supporting/contradicting; the bogus-UUID call returns `{"error": "insight not found"}`.

- [ ] **Step 4: Confirm the stdio server boots**

```bash
echo '' | .venv/bin/python -m knowledge_mcp.server & sleep 2; kill %1 2>/dev/null
```
Expected: no import/exception traceback before it's killed (it waits on stdin for MCP JSON-RPC). An error-free start is the pass condition.

- [ ] **Step 5: Commit**

```bash
git add knowledge_mcp/server.py knowledge_mcp/smoke.py
git commit -m "feat: add knowledge_mcp FastMCP server (7 tools) + live smoke"
```

---

### Task 5: Registration, README, read-only invariant check

Make it usable from Claude Code and document it.

**Files:**
- Create: `.mcp.json` (repo root)
- Create: `knowledge_mcp/README.md`

**Interfaces:** none (config + docs).

- [ ] **Step 1: Create the project MCP config**

Create `.mcp.json` at repo root:
```json
{
  "mcpServers": {
    "knowledge": {
      "command": ".venv/bin/python",
      "args": ["-m", "knowledge_mcp.server"]
    }
  }
}
```

- [ ] **Step 2: Write the README**

Create `knowledge_mcp/README.md`:
```markdown
# knowledge_mcp — Knowledge Layer MCP Server

Read-only MCP server exposing the ejnewsfeed knowledge layer (insights,
decisions, hypotheses, open questions) to local Claude Code skills.

## Setup

1. `.venv/bin/pip install -r knowledge_mcp/requirements.txt`
2. `grep -E '^(SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY)=' pipeline/.env > knowledge_mcp/.env`
   (or copy `.env.example` and fill in). The `.env` is gitignored.
3. Registered for this project via the repo-root `.mcp.json`; Claude Code
   auto-detects it. Verify with `claude mcp list`.

## Tools (all read-only)

- `search_insights(query?, domains?, status?, limit?)`
- `get_contested(domains?)`
- `knowledge_query(topic, domains?)`
- `get_insight_sources(insight_id)`
- `get_open_questions(domains?, status?)`
- `get_decisions(domains?, status?)`
- `get_hypotheses(domains?, status?)`

Domains: `ai, it, entrepreneurship, business, ux`.

## Test

- Unit: `.venv/bin/python -m pytest knowledge_mcp/tests -q`
- Live smoke: `.venv/bin/python -m knowledge_mcp.smoke`
```

- [ ] **Step 3: Verify the read-only invariant**

Run from repo root:
```bash
grep -rnE "\.(insert|update|delete|upsert)\(" knowledge_mcp/ && echo "WRITE CALL FOUND — FAIL" || echo "read-only OK"
```
Expected: `read-only OK` (no write calls anywhere in the package).

- [ ] **Step 4: Confirm Claude Code sees the server**

```bash
claude mcp list
```
Expected: the `knowledge` server appears (Claude Code read the project `.mcp.json`). If `claude` CLI isn't available in this shell, this is a manual check for EJ; note it and proceed.

- [ ] **Step 5: Commit**

```bash
git add .mcp.json knowledge_mcp/README.md
git commit -m "feat: register knowledge MCP server (.mcp.json) + README + read-only check"
```

---

## Self-Review

**Spec coverage:**
- Local stdio Python server, `service_role`, read-only → Tasks 1, 4, 5 ✅
- 7 tools with exact I/O → Task 4 (impl) + Task 2 (shaping) + Task 3 (reads) ✅
- Module split `server`/`db`/`queries` → Tasks 1–4 ✅
- `knowledge_mcp/` naming + `-m` invocation (SDK-shadow fix) → Global Constraints, Tasks 1/5 ✅
- Registration via `.mcp.json`, secrets from gitignored `.env` → Tasks 1, 5 ✅
- Testing: pure unit tests + live smoke + read-only invariant grep → Tasks 2, 4, 5 ✅

**Placeholder scan:** No TBD/TODO; every code and command step is concrete. ✅

**Type consistency:** `queries` function names/signatures identical across their Task 2 definition and Task 4 usage (`insight_status_filter`, `ilike_pattern`, `shape_insight`, `shape_contested`, `shape_insight_with_sources`, `shape_open_question`, `shape_decision`, `shape_hypothesis`, `consolidate_knowledge`). `db` fetch names/params identical across Task 3 definition and Task 4 usage. `SOURCE_SELECT` embed shape (`article:articles(... source:sources(name))`) matches what `queries.split_sources` reads (`row["article"]["source"]["name"]`), and `fetch_contested`'s embedded `insight_sources(...)` matches `shape_contested` reading `insight_row["insight_sources"]`. ✅
