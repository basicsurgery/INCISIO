-- ============================================================
-- Incisio — Supabase Database Setup
-- Run this entire file in your Supabase SQL Editor
-- Project: Settings → SQL Editor → New query → paste → Run
-- ============================================================

-- 1. Procedure entries table
CREATE TABLE IF NOT EXISTS procedure_entries (
  id            TEXT PRIMARY KEY,           -- client-generated UUID
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ,               -- soft delete

  -- Core fields
  date              TEXT,
  procedure_name    TEXT NOT NULL,
  procedure_code    TEXT,
  procedure_type    TEXT,
  specialty         TEXT,
  surgeon_name      TEXT,
  role_title        TEXT,
  reg_number        TEXT,
  competency_level  TEXT,
  duration          TEXT,
  complications     TEXT,
  outcome           TEXT,
  follow_up_date    TEXT,
  follow_up_notes   TEXT,
  supervisor_name   TEXT,
  signature_data    TEXT                   -- base64 PNG
);

-- 2. User profiles table
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id       UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name     TEXT,
  role_title    TEXT,
  reg_number    TEXT,
  hospital      TEXT,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Row Level Security — users only see their own data
ALTER TABLE procedure_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profiles     ENABLE ROW LEVEL SECURITY;

-- Procedure entries policies
CREATE POLICY "Users can read own entries"
  ON procedure_entries FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own entries"
  ON procedure_entries FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own entries"
  ON procedure_entries FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own entries"
  ON procedure_entries FOR DELETE
  USING (auth.uid() = user_id);

-- User profiles policies
CREATE POLICY "Users can read own profile"
  ON user_profiles FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can upsert own profile"
  ON user_profiles FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own profile"
  ON user_profiles FOR UPDATE
  USING (auth.uid() = user_id);

-- 4. Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER entries_updated_at
  BEFORE UPDATE ON procedure_entries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 5. Index for faster queries
CREATE INDEX IF NOT EXISTS idx_entries_user_id   ON procedure_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_entries_date       ON procedure_entries(user_id, date);
CREATE INDEX IF NOT EXISTS idx_entries_deleted    ON procedure_entries(user_id, deleted_at);
