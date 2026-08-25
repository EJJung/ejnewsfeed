-- ============================================================
-- EJ Newsfeed — Write-back schema (Phase 3c: Capture half, write-back)
-- Run in Supabase SQL Editor → New Query
-- Adds the proposal staging table + meeting_id provenance on two
-- knowledge-layer tables. Additive and nullable — the daily/weekly
-- distill-insights pipeline is unaffected.
-- ============================================================

CREATE TABLE IF NOT EXISTS writeback_proposals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id        UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('decision','hypothesis','open_question','summary')),
  text              TEXT NOT NULL,
  detail            TEXT,
  domains           TEXT[] NOT NULL DEFAULT '{}',
  included          BOOLEAN NOT NULL DEFAULT true,
  edited            BOOLEAN NOT NULL DEFAULT false,
  status            TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','committed','discarded')),
  committed_ref_id  UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_writeback_proposals_meeting ON writeback_proposals(meeting_id);

-- Provenance: match decisions' existing `meeting_id UUID` (plain, no FK).
ALTER TABLE hypotheses     ADD COLUMN IF NOT EXISTS meeting_id UUID;
ALTER TABLE open_questions ADD COLUMN IF NOT EXISTS meeting_id UUID;

-- ── RLS (mirror the meeting-pack pattern) ──
ALTER TABLE writeback_proposals ENABLE ROW LEVEL SECURITY;
CREATE POLICY writeback_proposals_service ON writeback_proposals FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY writeback_proposals_auth    ON writeback_proposals FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── Verify ──
SELECT table_name FROM information_schema.tables WHERE table_name = 'writeback_proposals';
SELECT column_name FROM information_schema.columns
WHERE table_name IN ('hypotheses','open_questions') AND column_name = 'meeting_id'
ORDER BY table_name;
