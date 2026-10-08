CREATE TABLE settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  local_date TEXT NOT NULL,
  answers TEXT NOT NULL,
  event_id TEXT,
  notify TEXT,
  email_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX bookings_time ON bookings (start_ms, end_ms);
CREATE INDEX bookings_date ON bookings (local_date);

-- Stand-in calendar used by the demo provider.
CREATE TABLE demo_events (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE demo_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  data TEXT NOT NULL
);
