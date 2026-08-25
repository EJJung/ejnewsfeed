-- ============================================================
-- EJ Newsfeed — Companion Session schema (Phase 3b: Capture half, session)
-- Run in Supabase SQL Editor → New Query
-- Adds the session transcript table and widens meetings.status.
-- Read-only consumer of the knowledge layer.
-- ============================================================

CREATE TABLE IF NOT EXISTS session_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id  UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content     TEXT NOT NULL,
  seq         INT NOT NULL,          -- monotonic turn order within the meeting (0 = companion opener)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_session_messages_meeting_seq
  ON session_messages(meeting_id, seq);

-- Widen meetings.status to add in_session + complete (reserved by the Prep spec).
-- The Prep schema created an inline single-column CHECK, auto-named
-- meetings_status_check. Drop and recreate it with the two new values.
ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_status_check;
ALTER TABLE meetings ADD CONSTRAINT meetings_status_check
  CHECK (status IN ('draft','assembling','pack_ready','approved','error','in_session','complete'));

-- ── RLS (mirror the meeting-pack pattern) ──
ALTER TABLE session_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY session_messages_service ON session_messages FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY session_messages_auth    ON session_messages FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── Verify ──
SELECT conname, pg_get_constraintdef(oid) AS def
FROM pg_constraint WHERE conname = 'meetings_status_check';
SELECT table_name FROM information_schema.tables WHERE table_name = 'session_messages';
