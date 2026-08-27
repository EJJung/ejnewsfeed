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
