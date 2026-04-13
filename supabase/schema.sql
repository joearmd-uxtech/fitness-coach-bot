-- ============================================================
-- Fitness AI Coach — Supabase Schema
-- Run this in the Supabase SQL Editor
-- ============================================================

-- Athlete profile (single row)
CREATE TABLE IF NOT EXISTS athlete_profile (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text,
  birth_year int,
  weight_kg numeric,
  height_cm int,
  injury_history jsonb,
  medical_notes text,
  longest_run_km numeric,
  current_plan text,
  current_plan_week int,
  target_race text,
  target_race_date date,
  city text,
  altitude_m int,
  updated_at timestamptz DEFAULT now()
);

-- Shoes
CREATE TABLE IF NOT EXISTS shoes (
  id text PRIMARY KEY, -- Strava gear ID (or manual slug until Strava is linked)
  nickname text,
  brand text,
  model text,
  color text,
  use_type text, -- easy / tempo / long / race / trail / versatile / retired
  heel_drop_mm int,
  cushioning text, -- max / moderate / firm
  carbon_plate boolean DEFAULT false,
  current_km numeric DEFAULT 0,
  max_km int DEFAULT 800,
  is_retired boolean DEFAULT false,
  notes text,
  last_synced_at timestamptz
);

-- Bikes
CREATE TABLE IF NOT EXISTS bikes (
  id text PRIMARY KEY, -- Strava gear ID (or manual slug)
  nickname text,
  type text, -- road / mtb / gravel
  current_km numeric DEFAULT 0,
  is_retired boolean DEFAULT false
);

-- Completed workouts (runs + rides from Strava)
CREATE TABLE IF NOT EXISTS workouts (
  id bigint PRIMARY KEY, -- Strava activity ID
  activity_type text, -- Run / Ride / TrailRun / VirtualRide
  name text,
  description text,
  start_date timestamptz,
  distance_km numeric,
  duration_seconds int,
  avg_pace_sec_km int, -- runs only
  avg_heart_rate int,
  max_heart_rate int,
  elevation_gain_m int,
  calories int,
  perceived_exertion int, -- Strava suffer score
  gear_id text, -- references shoes.id or bikes.id
  weather_temp_c numeric,
  weather_humidity int,
  weather_condition text,
  runna_plan_week int,
  strava_raw jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workouts_start_date ON workouts(start_date DESC);
CREATE INDEX IF NOT EXISTS idx_workouts_activity_type ON workouts(activity_type);

-- Planned workouts from Runna (extracted via Claude vision from screenshots)
CREATE TABLE IF NOT EXISTS planned_workouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  planned_date date,
  plan_week int,
  workout_type text, -- easy_run / long_run / tempo / intervals / strength / rest
  planned_distance_km numeric,
  description text,
  completed_workout_id bigint REFERENCES workouts(id),
  screenshot_parsed_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_planned_workouts_date ON planned_workouts(planned_date);

-- Daily health metrics (Apple Watch + ResMed BiPAP)
CREATE TABLE IF NOT EXISTS health_metrics (
  date date PRIMARY KEY,
  hrv_ms numeric,
  resting_heart_rate int,
  sleep_hours numeric,
  sleep_score int,
  bipap_hours numeric,
  bipap_ahi numeric, -- apnea events/hour — lower is better. <5 = normal
  steps int,
  active_calories int,
  recovery_score int, -- computed 0-100: composite of HRV + sleep + AHI
  source text DEFAULT 'apple_health',
  raw jsonb
);

-- Bot conversation history (persistent memory across Telegram sessions)
CREATE TABLE IF NOT EXISTS chat_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text, -- Telegram chat_id
  role text, -- user / assistant
  content text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_history_session ON chat_history(session_id, created_at DESC);
