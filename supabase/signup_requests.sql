-- Access request table for Google OAuth sign-in flow
-- Run this once in the Supabase SQL editor

CREATE TABLE IF NOT EXISTS signup_requests (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  email      text NOT NULL UNIQUE,
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE signup_requests ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read/write their own row
CREATE POLICY "manage_own_request"
  ON signup_requests FOR ALL
  TO authenticated
  USING (auth.email() = email)
  WITH CHECK (auth.email() = email);

-- Admin (ej.newsfeed@gmail.com) has full access to all rows
CREATE POLICY "admin_full_access"
  ON signup_requests FOR ALL
  TO authenticated
  USING (auth.email() = 'ej.newsfeed@gmail.com')
  WITH CHECK (auth.email() = 'ej.newsfeed@gmail.com');
