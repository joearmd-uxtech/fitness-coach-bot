-- ============================================================
-- Fitness AI Coach — Seed Data
-- Run AFTER schema.sql
-- ============================================================

-- Athlete profile
INSERT INTO athlete_profile (
  full_name, birth_year, weight_kg, height_cm,
  injury_history, medical_notes,
  longest_run_km, current_plan, current_plan_week,
  city, altitude_m
) VALUES (
  'Jose Amador', 1981, 98, 170,
  '[
    {"year": 1997, "type": "ACL reconstruction + meniscoplasty", "side": "left knee", "status": "recovered"},
    {"year": 2024, "type": "ankle sprain", "side": "right ankle", "status": "recovered"},
    {"year": 2025, "type": "Achilles tendinitis", "side": "unspecified", "status": "recovered — slight residual discomfort under overload"}
  ]'::jsonb,
  'High blood pressure since age 30, treated with Losartan 50mg daily. Sleep apnea diagnosed ~2022, uses ResMed AirCurve 10 Auto BiPAP nightly. Averages ~5hrs sleep. Weight loss in progress.',
  21,
  'Runna Run Further 26-week plan', 22,
  'Bogotá, Colombia', 2600
)
ON CONFLICT DO NOTHING;

-- ============================================================
-- Shoes (use slug IDs until Strava gear IDs are synced)
-- ============================================================
INSERT INTO shoes (id, nickname, brand, model, color, use_type, heel_drop_mm, cushioning, carbon_plate, current_km, max_km, is_retired, notes) VALUES
  ('shoe_ghost',       'Ghost',           'Brooks',  'Ghost 16',              'White',            'easy',      12,  'moderate', false,  35,  800, false, 'Daily easy runs and recovery. Very fresh.'),
  ('shoe_supernova',   'Supernova',        'Adidas',  'Supernova Rise',        'Black/Green',      'easy',      10,  'max',      false, 397,  800, false, 'Daily runs and recovery. Getting up there — watch mileage.'),
  ('shoe_boston',      'Boston',           'Adidas',  'Adizero Boston 13',     'Aqua/Lime',        'tempo',      8,  'moderate', false, 143,  700, false, 'Tempo, progressives, controlled long runs.'),
  ('shoe_adios_pro',   'Adios Pro',        'Adidas',  'Adizero Adios Pro 3',  'Light Blue/Light Green', 'race', 8,  'moderate', true,  211,  800, false, 'Race shoe only (10k, HM, marathon). Carbon plate degrades — flag after 400km. Do not use for routine training.'),
  ('shoe_nb1080',      'NB 1080',          'New Balance', '1080 v14',          'Grey/White',       'long',       8,  'max',      false, 253,  800, false, 'Long runs, easy runs, mileage accumulation.'),
  ('shoe_g22',         'G22',              'Brooks',  'Glycerin 22',           'Black',            'long',      10,  'max',      false, 154,  800, false, 'Long comfortable runs, fondos.'),
  ('shoe_pegasus',     'Pegasus',          'Nike',    'Pegasus 41',            'White',            'versatile', 10,  'moderate', false, 187,  700, false, 'Versatile: easy runs, fartlek, medium intervals.'),
  ('shoe_mach6',       'Mach 6',           'Hoka',    'Mach 6',                'Black',            'tempo',      5,  'moderate', false,  40,  700, false, 'Tempo and fartlek. Low heel drop — monitor Achilles when using.'),
  ('shoe_terrax',      'Terrax Trailblazer','Adidas',  'Terrex Soulstride',    'Black',            'trail',      8,  'moderate', false,  61,  800, false, 'Trail running only. Mountain and irregular terrain.')
ON CONFLICT (id) DO UPDATE SET
  current_km = EXCLUDED.current_km,
  is_retired  = EXCLUDED.is_retired,
  notes       = EXCLUDED.notes;

-- ============================================================
-- Bikes
-- ============================================================
INSERT INTO bikes (id, nickname, type, is_retired) VALUES
  ('bike_cliff',   'Cliff',       'mtb',  false),
  ('bike_gwk2',    'GW Letra K2', 'road', false)
ON CONFLICT (id) DO NOTHING;
