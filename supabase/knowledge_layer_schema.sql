-- ============================================================
-- EJ Newsfeed — Knowledge Layer Schema
-- Run in Supabase SQL Editor → New Query
-- ============================================================
--
-- insights is populated by the distill-insights Edge Function
-- (daily candidate extraction + weekly merge/contradiction pass).
-- decisions / hypotheses / open_questions are schema-only until
-- Phase 3 builds the meeting write-back loop that populates them.
-- ============================================================

-- ── insights ──────────────────────────────────────────────────────────────

CREATE TABLE insights (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  text              TEXT NOT NULL,
  domains           TEXT[] NOT NULL,
  confidence        FLOAT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN
                       ('candidate','active','contested','superseded','rejected')),
  superseded_by     UUID REFERENCES insights(id),
  first_seen_at     DATE NOT NULL,
  last_confirmed_at DATE,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_insights_status  ON insights(status);
CREATE INDEX idx_insights_domains ON insights USING GIN(domains);
CREATE INDEX idx_insights_first_seen ON insights(first_seen_at DESC);

ALTER TABLE insights ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read_insights"
  ON insights FOR SELECT TO anon USING (true);

CREATE POLICY "service_all_insights"
  ON insights FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── insight_sources ───────────────────────────────────────────────────────

CREATE TABLE insight_sources (
  insight_id UUID REFERENCES insights(id) ON DELETE CASCADE,
  article_id UUID REFERENCES articles(id) ON DELETE CASCADE,
  relation   TEXT NOT NULL CHECK (relation IN ('supporting','contradicting')),
  PRIMARY KEY (insight_id, article_id)
);

CREATE INDEX idx_insight_sources_article ON insight_sources(article_id);

ALTER TABLE insight_sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read_insight_sources"
  ON insight_sources FOR SELECT TO anon USING (true);

CREATE POLICY "service_all_insight_sources"
  ON insight_sources FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── decisions (schema only — populated in Phase 3) ──────────────────────────

CREATE TABLE decisions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  text       TEXT NOT NULL,
  context    TEXT,
  domains    TEXT[] NOT NULL,
  decided_at DATE,
  meeting_id UUID,
  status     TEXT NOT NULL CHECK (status IN ('standing','revisited','reversed')),
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE decisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read_decisions"
  ON decisions FOR SELECT TO anon USING (true);

CREATE POLICY "service_all_decisions"
  ON decisions FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── hypotheses (schema only — populated in Phase 3) ─────────────────────────

CREATE TABLE hypotheses (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  statement  TEXT NOT NULL,
  domains    TEXT[] NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('open','supported','refuted')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE hypotheses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read_hypotheses"
  ON hypotheses FOR SELECT TO anon USING (true);

CREATE POLICY "service_all_hypotheses"
  ON hypotheses FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE hypothesis_evidence (
  hypothesis_id UUID REFERENCES hypotheses(id) ON DELETE CASCADE,
  insight_id    UUID REFERENCES insights(id) ON DELETE CASCADE,
  stance        TEXT NOT NULL CHECK (stance IN ('for','against')),
  PRIMARY KEY (hypothesis_id, insight_id)
);

ALTER TABLE hypothesis_evidence ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read_hypothesis_evidence"
  ON hypothesis_evidence FOR SELECT TO anon USING (true);

CREATE POLICY "service_all_hypothesis_evidence"
  ON hypothesis_evidence FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── open_questions (schema only — populated in Phase 3) ─────────────────────

CREATE TABLE open_questions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question             TEXT NOT NULL,
  why_it_matters       TEXT,
  domains              TEXT[] NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('open','answered')),
  resolving_insight_id UUID REFERENCES insights(id),
  created_at           TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE open_questions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read_open_questions"
  ON open_questions FOR SELECT TO anon USING (true);

CREATE POLICY "service_all_open_questions"
  ON open_questions FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Verify ────────────────────────────────────────────────────────────────

SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('insights','insight_sources','decisions','hypotheses','hypothesis_evidence','open_questions')
ORDER BY table_name;
