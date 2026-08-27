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
