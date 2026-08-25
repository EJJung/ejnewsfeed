-- ============================================================
-- EJ Newsfeed — Meeting Pack schema (Phase 3a: prep)
-- Run in Supabase SQL Editor → New Query
-- Read-only consumer of the knowledge layer; adds two new tables.
-- ============================================================

CREATE TABLE IF NOT EXISTS meetings (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title               TEXT NOT NULL,
  agenda              TEXT NOT NULL,
  prospective_result  TEXT,
  decision_questions  TEXT[] NOT NULL DEFAULT '{}',
  status              TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','assembling','pack_ready','approved','error')),
  error_message       TEXT,
  summary             TEXT,               -- reserved for the follow-on write-back spec; unused here
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS context_cards (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id    UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  card_type     TEXT NOT NULL
                CHECK (card_type IN ('insight','decision','hypothesis','open_question','article','manual')),
  ref_table     TEXT,                     -- source table for sourced cards; null for 'manual'
  ref_id        UUID,                     -- source row id; null for 'manual'
  headline      TEXT NOT NULL,
  body          TEXT NOT NULL,
  why_relevant  TEXT,                     -- Claude's rationale; null for 'manual'
  included      BOOLEAN NOT NULL DEFAULT true,
  edited        BOOLEAN NOT NULL DEFAULT false,
  position      INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_context_cards_meeting ON context_cards(meeting_id);
CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status);

-- Keep updated_at fresh on meetings.
CREATE OR REPLACE FUNCTION set_meetings_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_meetings_updated_at ON meetings;
CREATE TRIGGER trg_meetings_updated_at
  BEFORE UPDATE ON meetings
  FOR EACH ROW EXECUTE FUNCTION set_meetings_updated_at();

-- ── RLS (mirror knowledge-layer pattern: service_role full, authenticated read/write) ──
ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_cards ENABLE ROW LEVEL SECURITY;

CREATE POLICY meetings_service ON meetings FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY context_cards_service ON context_cards FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Single private user: authenticated may read and write both tables (the
-- dashboard creates/edits meetings and cards directly).
CREATE POLICY meetings_auth ON meetings FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY context_cards_auth ON context_cards FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── Verify ──
SELECT table_name FROM information_schema.tables
WHERE table_name IN ('meetings','context_cards') ORDER BY table_name;
