'use strict';

const { DatabaseSync } = require('node:sqlite');

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL CHECK (role IN ('admin','staff','parent')),
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT ${NOW},
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS students (
  id         INTEGER PRIMARY KEY,
  student_no TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  last_name  TEXT NOT NULL,
  grade      TEXT NOT NULL DEFAULT '',
  section    TEXT NOT NULL DEFAULT '',
  card_uid   TEXT UNIQUE,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE IF NOT EXISTS guardians (
  id           INTEGER PRIMARY KEY,
  student_id   INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  relationship TEXT NOT NULL DEFAULT '',
  phone        TEXT NOT NULL,
  notify_sms   INTEGER NOT NULL DEFAULT 1,
  invite_code  TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS guardians_phone ON guardians(phone);
CREATE INDEX IF NOT EXISTS guardians_student ON guardians(student_id);

CREATE TABLE IF NOT EXISTS devices (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  location     TEXT NOT NULL DEFAULT '',
  mode         TEXT NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto','in','out')),
  key_hash     TEXT NOT NULL UNIQUE,
  key_hint     TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT,
  created_at   TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE IF NOT EXISTS attendance (
  id          INTEGER PRIMARY KEY,
  student_id  INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  direction   TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  at          TEXT NOT NULL,
  local_date  TEXT NOT NULL,
  device_id   INTEGER REFERENCES devices(id) ON DELETE SET NULL,
  method      TEXT NOT NULL DEFAULT 'nfc' CHECK (method IN ('nfc','manual')),
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS attendance_student_at ON attendance(student_id, at);
CREATE INDEX IF NOT EXISTS attendance_date ON attendance(local_date, at);

CREATE TABLE IF NOT EXISTS unknown_taps (
  card_uid  TEXT PRIMARY KEY,
  device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
  count     INTEGER NOT NULL DEFAULT 1,
  first_at  TEXT NOT NULL,
  last_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id            INTEGER PRIMARY KEY,
  attendance_id INTEGER REFERENCES attendance(id) ON DELETE CASCADE,
  guardian_id   INTEGER REFERENCES guardians(id) ON DELETE SET NULL,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  channel       TEXT NOT NULL CHECK (channel IN ('sms','push')),
  kind          TEXT NOT NULL DEFAULT 'attendance',
  recipient     TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  message       TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending','sent','failed')),
  error         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT ${NOW},
  sent_at       TEXT
);
CREATE INDEX IF NOT EXISTS notifications_created ON notifications(created_at);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
`;

function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDatabase, transaction };
