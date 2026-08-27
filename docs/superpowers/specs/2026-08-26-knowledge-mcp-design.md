# Knowledge Layer MCP Server — Design Spec

*Drafted 2026-08-26 from discussion between EJ and Claude. Phase 4 (first sub-project).*

## Concept

Expose the ejnewsfeed **knowledge layer** (insights, decisions, hypotheses, open
questions — all domain-tagged and source-linked) to EJ's professional-reasoning
system as a set of read-only query tools over the Model Context Protocol (MCP).
This lets Claude Code skills running locally ask the knowledge layer questions —
the plan's north-star use case: *"what do we currently believe about X, and
what's contested?"* — instead of that knowledge living only inside the dashboard.

This is the first Phase 4 sub-project. Phase 4's other directions (engagement
recommendations, insight-graph visualization) are out of scope here and get their
own specs later.

## Consumer & transport

- **Consumer:** Claude Code skills/agents running locally on EJ's machine.
- **Transport:** a **local stdio MCP server** (official Python `mcp` SDK), launched
  on demand by Claude Code. No hosting, no public surface, no new auth layer.

## Data access & security

The server reads Supabase over the `supabase-py` client (same stack the
`pipeline/` scripts use) with the **`service_role` key**, loaded from a local
`knowledge_mcp/.env` via `python-dotenv`.

Rationale for `service_role` over the `anon` key: the knowledge tables grant read
to both `anon` and `authenticated`, but **`articles` is `authenticated`-only** (its
`anon` read policy was deliberately dropped — see `rls.sql`). The
`get_insight_sources` and `get_contested` tools must return article titles/URLs, so
an `anon` key would yield bare IDs. `service_role` is the pragmatic choice for a
local, single-user, trusted server; the key already lives in `pipeline/.env`. The
server is **read-only by construction** — it defines no write tools and issues only
SELECTs. This is stated as an invariant the implementation must preserve.

## The knowledge layer (as it exists)

- `insights` — `id, text, domains[], confidence, status (candidate|active|contested|superseded|rejected), superseded_by, first_seen_at, last_confirmed_at`. Populated (~64 active).
- `insight_sources` — `insight_id, article_id, relation (supporting|contradicting)`; `article_id` → `articles(title, url, source_id→sources.name)`.
- `decisions` — `text, context, domains[], decided_at, meeting_id, status (standing|revisited|reversed)`. Empty until write-back fills it.
- `hypotheses` — `statement, domains[], status (open|supported|refuted)`; `hypothesis_evidence(hypothesis_id, insight_id, stance (for|against))`. Empty.
- `open_questions` — `question, why_it_matters, domains[], status (open|answered), resolving_insight_id`. Empty.

Domain vocabulary: `ai, it, entrepreneurship, business, ux`. A `domains` filter
matches rows whose `domains[]` **overlaps** the requested list (Postgres `&&`,
`supabase-py` `.overlaps()`).

## The 7 tools

All read-only. All return compact JSON shaped for an LLM to reason over. Empty
tables return `[]` (or an empty section) cleanly — never an error.

### 1. `search_insights(query?, domains?, status?, limit?)`
- `query` (str, optional): substring matched case-insensitively against `insights.text` (`ILIKE %query%`). Omitted → no text filter.
- `domains` (list[str], optional): overlap filter.
- `status` (list[str], optional): defaults to `["active","contested"]` (mirrors the dashboard default). Accepts any subset of the five statuses.
- `limit` (int, optional): default 20.
- Returns: list of `{id, text, domains, confidence, status, first_seen_at, last_confirmed_at}`, newest `first_seen_at` first.

### 2. `get_contested(domains?)`
- `domains` (list[str], optional): overlap filter.
- Returns: list of contested insights, each `{id, text, domains, confidence, supporting: [{title, url, source}], contradicting: [{title, url, source}]}` — sources split by `relation`. This is the tool that surfaces the actual contradictions.

### 3. `knowledge_query(topic, domains?)`
- `topic` (str, required): substring matched (`ILIKE`) across each table's primary text field — `insights.text`, `open_questions.question`, `decisions.text`, `hypotheses.statement`.
- `domains` (list[str], optional): overlap filter applied to every section.
- Returns: a consolidated `{topic, insights: [...], open_questions: [...], decisions: [...], hypotheses: [...]}` — the "what do we know about X" one-shot. Sections backed by empty tables come back as `[]`.

### 4. `get_insight_sources(insight_id)`
- `insight_id` (str/UUID, required).
- Returns: `{id, text, domains, confidence, status, supporting: [{title, url, source}], contradicting: [{title, url, source}]}`. If the id doesn't exist, returns `{error: "insight not found"}` (a normal payload, not a thrown MCP error).

### 5. `get_open_questions(domains?, status?)`
- `status` default `"open"` (accepts `"answered"`). `domains` overlap filter.
- Returns: list of `{id, question, why_it_matters, domains, status}`.

### 6. `get_decisions(domains?, status?)`
- `status` default `"standing"`. `domains` overlap filter.
- Returns: list of `{id, text, context, domains, decided_at, status}`.

### 7. `get_hypotheses(domains?, status?)`
- `status` default `"open"`. `domains` overlap filter.
- Returns: list of `{id, statement, domains, status, evidence: {for: [insight_text...], against: [insight_text...]}}` — evidence hydrated from `hypothesis_evidence` → `insights.text`, split by `stance`.

## Module structure

New top-level Python **package** `knowledge_mcp/` (sibling to `pipeline/`,
`dashboard/`, `supabase/`). It is deliberately **not** named `mcp/`: a top-level
`mcp/` directory would shadow the installed `mcp` SDK package in some
execution/test contexts. The server runs as a module (`-m knowledge_mcp.server`)
from the repo root, so internal imports are absolute (`from knowledge_mcp import
queries, db`) and resolve cleanly in both the server and the tests.

| File | Responsibility |
|---|---|
| `knowledge_mcp/__init__.py` | Marks the package. |
| `knowledge_mcp/server.py` | MCP entrypoint: registers the 7 tools with `FastMCP`, parses tool args, calls `db` + `queries`, returns JSON. Thin — no query logic. Tool implementations are plain functions (also imported by `smoke.py`). |
| `knowledge_mcp/db.py` | Thin Supabase access: `get_client()` (`load_dotenv(knowledge_mcp/.env)` → `create_client`), plus one small fetch function per table-read the tools need (applies filters via the supabase-py builder). |
| `knowledge_mcp/queries.py` | **Pure** logic: filter-argument construction from tool inputs (status defaults, domain overlap, ILIKE pattern) and response-shaping from raw rows (splitting sources by relation, consolidating `knowledge_query`, hydrating hypothesis evidence). No I/O — unit-testable. |
| `knowledge_mcp/requirements.txt` | `mcp`, `supabase>=2.3.0`, `python-dotenv>=1.0.0`. |
| `knowledge_mcp/.env.example` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (real `knowledge_mcp/.env` is gitignored; values copied from `pipeline/.env`). |
| `knowledge_mcp/README.md` | What it is, the 7 tools, and the Claude Code registration snippet. |
| `knowledge_mcp/tests/test_queries.py` | Unit tests for `queries.py`. |
| `knowledge_mcp/smoke.py` | Live smoke: runs each tool against real Supabase, prints results. |

The `server` → (`queries` for shaping, `db` for I/O) split keeps all testable logic
pure and out of the SDK/network layer.

## Registration (Claude Code)

The server self-loads secrets from `knowledge_mcp/.env`, so the MCP config carries
no secrets. A project-root `.mcp.json` entry (documented in the README), which
Claude Code auto-detects for this project:

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

(`.venv/bin/python` so the `mcp`/`supabase` deps resolve from the project venv;
`-m knowledge_mcp.server` run from the repo root so the package imports resolve and
the `mcp` SDK is never shadowed.)

## Testing

- **Unit (`test_queries.py`):** pure functions in `queries.py` — status defaulting
  (e.g. `search_insights` → `["active","contested"]` when omitted), domain-overlap
  arg construction, ILIKE pattern building, source-splitting by relation
  (supporting vs contradicting), `knowledge_query` consolidation shape (including
  all-empty-tables → empty sections), and hypothesis-evidence for/against
  hydration. No DB or network.
- **Live smoke (`smoke.py`):** invoke all 7 tools against production Supabase.
  Confirm `search_insights`/`get_contested`/`knowledge_query` return real insight
  data, the three write-back-backed tools return `[]` cleanly (tables still empty),
  and `get_insight_sources` on a real contested insight returns split
  supporting/contradicting articles with titles.
- **Read-only invariant check:** grep confirms no table write call
  (`.insert(`/`.update(`/`.delete(`/`.upsert(`) exists anywhere under `knowledge_mcp/`.

## Scope guardrails (YAGNI)

Read-only only (write-back stays its own pipeline; no write tools). No caching. No
pagination beyond `limit`. No semantic/embedding search — `ILIKE` substring
matching for v1, with a clean upgrade path to Postgres full-text later. No hosted/
HTTP transport. No auth layer (local stdio on a trusted machine).

## Success criteria

From a Claude Code skill on EJ's machine, calling the `knowledge` MCP server's
`knowledge_query("agent pricing")` (or `get_contested(["ai"])`) returns the
relevant insights and their contradictions, so a reasoning skill can ground itself
in "what we currently believe and what's contested" without touching the dashboard
or the database directly.
