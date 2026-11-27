CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  google_id TEXT UNIQUE NOT NULL,
  email TEXT,
  name TEXT,
  picture TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT '₸',
  date TEXT NOT NULL DEFAULT '',
  budget REAL NOT NULL DEFAULT 600000,
  members TEXT NOT NULL DEFAULT '[]',
  invite_token TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trips_invite_token
  ON trips(invite_token) WHERE invite_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS trip_members (
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (trip_id, user_id)
);

INSERT INTO trip_members (trip_id, user_id, role)
SELECT id, user_id, 'owner' FROM trips WHERE 1
ON CONFLICT (trip_id, user_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  description TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  payer TEXT NOT NULL DEFAULT '',
  participants TEXT NOT NULL DEFAULT '[]',
  date TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '💳',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS places (
  id TEXT PRIMARY KEY,
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  cost REAL NOT NULL DEFAULT 0,
  favorite INTEGER NOT NULL DEFAULT 0,
  lat REAL,
  lng REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_trips_user ON trips(user_id);
CREATE INDEX IF NOT EXISTS idx_expenses_trip ON expenses(trip_id);
CREATE INDEX IF NOT EXISTS idx_places_trip ON places(trip_id);
