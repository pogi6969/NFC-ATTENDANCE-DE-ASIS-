'use strict';

// Fills the database with demo students, parents, a gate reader and a week of taps.
// Usage: npm run seed
const crypto = require('node:crypto');
const { loadConfig } = require('./config');
const { openDatabase, transaction } = require('./db');
const { createSettings } = require('./settings');
const { localDate, randomCode, sha256 } = require('./util');

const STUDENTS = [
  ['2026-0001', 'Juan', 'Dela Cruz', 'Grade 10', 'Rizal', '04A23B91', 'Maria Dela Cruz', 'Mother', '+639170000001'],
  ['2026-0002', 'Ana', 'Santos', 'Grade 10', 'Rizal', '04B7C2D3', 'Jose Santos', 'Father', '+639170000002'],
  ['2026-0003', 'Miguel', 'Reyes', 'Grade 10', 'Bonifacio', '04C1E5F7', 'Liza Reyes', 'Mother', '+639170000003'],
  ['2026-0004', 'Sofia', 'Garcia', 'Grade 9', 'Mabini', '04D9A8B6', 'Ramon Garcia', 'Father', '+639170000004'],
  ['2026-0005', 'Paolo', 'Mendoza', 'Grade 9', 'Mabini', '04E3F4A5', 'Grace Mendoza', 'Mother', '+639170000005'],
  ['2026-0006', 'Bea', 'Torres', 'Grade 8', 'Luna', '04F6B7C8', 'Carlo Torres', 'Guardian', '+639170000006'],
  ['2026-0007', 'Andrei', 'Flores', 'Grade 8', 'Luna', '0411D2E3', 'Nina Flores', 'Mother', '+639170000007'],
  ['2026-0008', 'Kyla', 'Ramos', 'Grade 7', 'Aguinaldo', '0422E3F4', 'Ben Ramos', 'Father', '+639170000008'],
];

const config = loadConfig();
const db = openDatabase(config.dbPath);
const settings = createSettings(db, config);
const tz = settings.get().timezone;

transaction(db, () => {
  for (const [no, first, last, grade, section, uid, gName, rel, phone] of STUDENTS) {
    if (db.prepare('SELECT 1 FROM students WHERE student_no = ?').get(no)) continue;
    const sid = Number(
      db.prepare('INSERT INTO students (student_no, first_name, last_name, grade, section, card_uid) VALUES (?, ?, ?, ?, ?, ?)')
        .run(no, first, last, grade, section, uid).lastInsertRowid,
    );
    db.prepare('INSERT INTO guardians (student_id, name, relationship, phone, invite_code) VALUES (?, ?, ?, ?, ?)').run(sid, gName, rel, phone, randomCode());
  }

  let device = db.prepare("SELECT id FROM devices WHERE name = 'Main Gate'").get();
  if (!device) {
    const key = `dev_${crypto.randomBytes(24).toString('base64url')}`;
    device = { id: Number(db.prepare("INSERT INTO devices (name, location, key_hash, key_hint) VALUES ('Main Gate', 'Front entrance', ?, ?)").run(sha256(key), key.slice(-4)).lastInsertRowid) };
    console.log(`Main Gate reader key: ${key}`);
    console.log(`Pairing link: /app/#gate/pair/${key}`);
  }

  // Past school days: arrive 6:45-7:50, leave 16:00-17:00 (school time zone, shown as UTC+8 here).
  if (!db.prepare('SELECT 1 FROM attendance LIMIT 1').get()) {
    const students = db.prepare('SELECT id FROM students').all();
    const insert = db.prepare("INSERT INTO attendance (student_id, direction, at, local_date, device_id) VALUES (?, ?, ?, ?, ?)");
    for (let back = 7; back >= 1; back--) {
      const day = new Date(Date.now() - back * 86400000);
      const date = localDate(day, tz);
      const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      for (const s of students) {
        if (Math.random() < 0.08) continue;
        const inAt = new Date(`${date}T07:00:00+08:00`);
        inAt.setUTCMinutes(inAt.getUTCMinutes() - 15 + Math.floor(Math.random() * 65));
        const outAt = new Date(`${date}T16:00:00+08:00`);
        outAt.setUTCMinutes(outAt.getUTCMinutes() + Math.floor(Math.random() * 60));
        insert.run(s.id, 'IN', inAt.toISOString(), localDate(inAt, tz), device.id);
        insert.run(s.id, 'OUT', outAt.toISOString(), localDate(outAt, tz), device.id);
      }
    }
  }
});

console.log(`Demo data ready: ${STUDENTS.length} students with cards and parent numbers.`);
db.close();
