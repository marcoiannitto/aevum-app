-- AEVUM D1 Schema v2.0.0
-- Maps all Google Sheet tabs to relational tables + auth layer

-- ═══════════════════════════════════════════════════════════════
-- AUTH
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE auth_tokens (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'user',  -- 'user' or 'admin'
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT,                           -- NULL = never expires
  UNIQUE(user_id, role)
);

-- ═══════════════════════════════════════════════════════════════
-- PER-USER TABLES
-- ═══════════════════════════════════════════════════════════════

-- Profile tab → users
CREATE TABLE users (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  sex                   TEXT CHECK(sex IN ('m','f')),
  age                   INTEGER,
  height                REAL,
  start_weight          REAL,
  activity              REAL DEFAULT 1.55,
  target_kg             REAL,
  start_date            TEXT,
  activation_days       REAL,
  activation_model      TEXT DEFAULT 'buckets',
  stab_target_weight    REAL,
  maint_target_weight   REAL,
  current_target_kcal   REAL,
  prev_target_kcal      REAL,
  last_review_date      TEXT,
  last_change_reason    TEXT,
  maintenance_mode      TEXT,
  maintenance_diet      TEXT,
  program               INTEGER DEFAULT 0,   -- 0=free, 1=program client
  notes                 TEXT,
  email                 TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Data tab → daily_logs
CREATE TABLE daily_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL,
  day           INTEGER NOT NULL,
  phase         TEXT,
  date          TEXT,
  weight        REAL,
  waist         REAL,
  serum_am      TEXT,
  serum_pm      TEXT,
  kcal          REAL,
  protein       REAL,
  fat           REAL,
  carbs         REAL,
  water_ml      REAL,
  exercise      TEXT,
  exercise_kcal REAL,
  energy        TEXT,
  hunger        TEXT,
  sleep         TEXT,
  notes         TEXT,
  day_json      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, day)
);

-- MealPlan tab → meal_plans
CREATE TABLE meal_plans (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   TEXT NOT NULL,
  day       INTEGER NOT NULL,
  meal      TEXT,
  recipe    TEXT,
  kcal      REAL DEFAULT 0,
  protein   REAL DEFAULT 0,
  fat       REAL DEFAULT 0,
  carbs     REAL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ═══════════════════════════════════════════════════════════════
-- SHARED / REFERENCE TABLES (Marco-managed via admin)
-- ═══════════════════════════════════════════════════════════════

-- Recipes tab
CREATE TABLE recipes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  protein     TEXT,
  cuisine     TEXT,
  phase       TEXT,
  kcal        REAL DEFAULT 0,
  protein_g   REAL DEFAULT 0,
  fat_g       REAL DEFAULT 0,
  carbs_g     REAL DEFAULT 0,
  ingredients TEXT,    -- stored as || separated
  steps       TEXT     -- stored as || separated
);

-- Messages tab
CREATE TABLE messages (
  id        TEXT PRIMARY KEY,
  trigger   TEXT NOT NULL,
  enabled   TEXT DEFAULT 'yes',
  phase     TEXT,
  priority  INTEGER DEFAULT 0,
  title     TEXT,
  body      TEXT,
  badge     TEXT,
  frequency TEXT DEFAULT 'daily'
);

-- Movements tab
CREATE TABLE movements (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  phase     TEXT,
  equipment TEXT,
  video_url TEXT,
  cues      TEXT,     -- || separated
  mistake   TEXT
);

-- Workouts tab (one row per movement in a routine)
CREATE TABLE workouts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workout_id    TEXT NOT NULL,
  workout_name  TEXT,
  phase         TEXT,
  duration_min  INTEGER,
  sort_order    INTEGER,
  movement_id   TEXT,
  sets          INTEGER,
  reps          INTEGER,
  rest_sec      INTEGER
);

-- Rules tab
CREATE TABLE rules (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  phase     TEXT NOT NULL,
  model     TEXT DEFAULT 'all',
  metric    TEXT NOT NULL,
  basis     TEXT DEFAULT 'fixed',
  value     REAL,
  green_lo  REAL,
  green_hi  REAL,
  amber_lo  REAL,
  amber_hi  REAL,
  gated     TEXT DEFAULT 'yes',
  unit      TEXT
);

-- Foods tab
CREATE TABLE foods (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  phase       TEXT NOT NULL,
  category    TEXT,
  subcategory TEXT,
  item        TEXT NOT NULL,
  verdict     TEXT DEFAULT 'yes',
  cap_g       REAL,
  note        TEXT
);

-- Policy tab
CREATE TABLE policy (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  phase       TEXT NOT NULL UNIQUE,
  rules_text  TEXT NOT NULL
);

-- Config tab (key-value)
CREATE TABLE config (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ═══════════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════════

CREATE INDEX idx_daily_logs_user    ON daily_logs(user_id);
CREATE INDEX idx_daily_logs_day     ON daily_logs(user_id, day);
CREATE INDEX idx_meal_plans_user    ON meal_plans(user_id);
CREATE INDEX idx_auth_tokens_user   ON auth_tokens(user_id);
CREATE INDEX idx_rules_phase        ON rules(phase, metric);
CREATE INDEX idx_foods_phase        ON foods(phase);
CREATE INDEX idx_workouts_id        ON workouts(workout_id);
