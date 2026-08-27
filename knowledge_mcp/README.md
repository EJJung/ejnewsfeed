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
