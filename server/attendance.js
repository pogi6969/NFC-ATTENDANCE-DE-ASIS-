'use strict';

const { HttpError, uidCandidates, validUid, localDate, localHM, timeLabel } = require('./util');

const LOG_SELECT = `
  SELECT a.id, a.student_id, a.direction, a.at, a.local_date, a.method, a.note, a.device_id,
         s.student_no, s.first_name, s.last_name, s.grade, s.section,
         d.name AS device_name, u.name AS recorded_by_name
  FROM attendance a
  JOIN students s ON s.id = a.student_id
  LEFT JOIN devices d ON d.id = a.device_id
  LEFT JOIN users u ON u.id = a.recorded_by`;

const MAX_BACKDATE_MS = 7 * 86400000;

function createAttendance(ctx) {
  const { db } = ctx;

  const studentByUid = db.prepare('SELECT * FROM students WHERE card_uid = ?');
  const studentById = db.prepare('SELECT * FROM students WHERE id = ?');
  const lastBefore = db.prepare(
    'SELECT * FROM attendance WHERE student_id = ? AND local_date = ? AND at <= ? ORDER BY at DESC, id DESC LIMIT 1',
  );
  const nearby = db.prepare(
    'SELECT * FROM attendance WHERE student_id = ? AND at >= ? AND at <= ? ORDER BY at DESC, id DESC LIMIT 1',
  );
  const insert = db.prepare(
    'INSERT INTO attendance (student_id, direction, at, local_date, device_id, method, recorded_by, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const logById = db.prepare(`${LOG_SELECT} WHERE a.id = ?`);
  const unknownUpsert = db.prepare(`
    INSERT INTO unknown_taps (card_uid, device_id, count, first_at, last_at) VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(card_uid) DO UPDATE SET count = count + 1, device_id = excluded.device_id, last_at = excluded.last_at`);

  const tz = () => ctx.settings.get().timezone;

  function decorate(row) {
    return { ...row, student_name: `${row.first_name} ${row.last_name}`, time_label: timeLabel(new Date(row.at), tz()) };
  }

  function studentInfo(student) {
    return {
      id: student.id,
      name: `${student.first_name} ${student.last_name}`,
      first_name: student.first_name,
      student_no: student.student_no,
      grade: student.grade,
      section: student.section,
    };
  }

  function findStudentByUid(raw) {
    for (const uid of uidCandidates(raw)) {
      const student = studentByUid.get(uid);
      if (student) return student;
    }
    return null;
  }

  // Readers send a time only for taps they saved while offline. Accepts ISO text,
  // Unix seconds or milliseconds. A clock that runs ahead falls back to server time.
  function resolveTime(at) {
    const now = new Date();
    if (at === undefined || at === null || at === '') return now;
    const when = typeof at === 'number' ? new Date(at < 1e12 ? at * 1000 : at) : new Date(String(at));
    if (Number.isNaN(when.getTime())) throw new HttpError(400, 'Tap time is not valid.');
    if (when > now) return now;
    if (now - when > MAX_BACKDATE_MS) throw new HttpError(400, 'This tap is older than 7 days and was not saved.');
    return when;
  }

  function record({ student, direction, when, deviceId = null, method = 'nfc', userId = null, note = '', gate }) {
    const info = insert.run(student.id, direction, when.toISOString(), localDate(when, tz()), deviceId, method, userId, note);
    const log = decorate(logById.get(Number(info.lastInsertRowid)));
    ctx.events.broadcast('attendance', log, student.id);
    ctx.notifier.onAttendance(log, student, gate);
    return log;
  }

  function nextDirection(student, when, mode) {
    if (mode === 'in') return 'IN';
    if (mode === 'out') return 'OUT';
    const last = lastBefore.get(student.id, localDate(when, tz()), when.toISOString());
    return last && last.direction === 'IN' ? 'OUT' : 'IN';
  }

  function tap({ uid, at, device }) {
    const candidates = uidCandidates(uid);
    if (!candidates.length || !validUid(candidates[0])) throw new HttpError(400, 'Card ID is not valid.');
    const when = resolveTime(at);
    const student = findStudentByUid(uid);

    if (!student) {
      const iso = when.toISOString();
      unknownUpsert.run(candidates[0], device ? device.id : null, iso, iso);
      ctx.events.broadcast('unknown-card', { uid: candidates[0], device_name: device ? device.name : '', at: iso });
      return { status: 'unknown', uid: candidates[0], message: 'Card not registered. Please go to the school office.' };
    }

    const info = studentInfo(student);
    if (!student.active) {
      return { status: 'inactive', student: info, message: 'This card is turned off. Please go to the school office.' };
    }

    const cooldown = ctx.settings.get().tap_cooldown_seconds;
    if (cooldown > 0) {
      const from = new Date(when.getTime() - cooldown * 1000).toISOString();
      const to = new Date(when.getTime() + cooldown * 1000).toISOString();
      const recent = nearby.get(student.id, from, to);
      if (recent) {
        const time = timeLabel(new Date(recent.at), tz());
        return {
          status: 'duplicate',
          direction: recent.direction,
          at: recent.at,
          time,
          student: info,
          message: `Already recorded: ${recent.direction === 'IN' ? 'entry' : 'exit'} at ${time}.`,
        };
      }
    }

    const direction = nextDirection(student, when, device ? device.mode : 'auto');
    const log = record({
      student,
      direction,
      when,
      deviceId: device ? device.id : null,
      method: 'nfc',
      gate: device ? device.name : 'gate',
    });
    return {
      status: 'ok',
      direction,
      at: log.at,
      time: log.time_label,
      log_id: log.id,
      student: info,
      message: direction === 'IN' ? `Welcome, ${student.first_name}!` : `Goodbye, ${student.first_name}!`,
    };
  }

  function manual({ studentId, direction, at, user, note = '' }) {
    const student = studentById.get(studentId);
    if (!student) throw new HttpError(404, 'Student not found.');
    const when = resolveTime(at);
    let dir = String(direction || 'auto').toUpperCase();
    if (dir === 'AUTO') dir = nextDirection(student, when, 'auto');
    if (dir !== 'IN' && dir !== 'OUT') throw new HttpError(400, 'Direction must be IN or OUT.');
    return record({ student, direction: dir, when, method: 'manual', userId: user.id, note, gate: 'school office' });
  }

  function list({ from, to, studentId, q, direction, grade, section, limit = 500 } = {}) {
    const where = [];
    const params = [];
    const add = (condition, ...values) => {
      where.push(condition);
      params.push(...values);
    };
    if (from) add('a.local_date >= ?', from);
    if (to) add('a.local_date <= ?', to);
    if (studentId) add('a.student_id = ?', studentId);
    if (direction) add('a.direction = ?', direction);
    if (grade) add('s.grade = ?', grade);
    if (section) add('s.section = ?', section);
    if (q) {
      const like = `%${q}%`;
      add("((s.first_name || ' ' || s.last_name) LIKE ? OR (s.last_name || ', ' || s.first_name) LIKE ? OR s.student_no LIKE ?)", like, like, like);
    }
    const sql = `${LOG_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.at DESC, a.id DESC LIMIT ?`;
    params.push(Math.min(Math.max(Number(limit) || 500, 1), 20000));
    return db.prepare(sql).all(...params).map(decorate);
  }

  function daySnapshot(date) {
    const map = new Map();
    for (const r of db.prepare('SELECT student_id, direction, at FROM attendance WHERE local_date = ? ORDER BY at, id').all(date)) {
      let e = map.get(r.student_id);
      if (!e) {
        e = { first_in: null, last_out: null, last_direction: null, last_at: null, taps: 0 };
        map.set(r.student_id, e);
      }
      e.taps++;
      if (r.direction === 'IN' && !e.first_in) e.first_in = r.at;
      if (r.direction === 'OUT') e.last_out = r.at;
      e.last_direction = r.direction;
      e.last_at = r.at;
    }
    return map;
  }

  function statusOf(entry) {
    const s = ctx.settings.get();
    if (!entry) return { status: 'absent', late: false, on_campus: false };
    const late = !!entry.first_in && localHM(new Date(entry.first_in), s.timezone) > s.late_time;
    return { status: late ? 'late' : 'present', late, on_campus: entry.last_direction === 'IN' };
  }

  function today() {
    const date = localDate(new Date(), tz());
    const students = db.prepare('SELECT id FROM students WHERE active = 1').all();
    const snap = daySnapshot(date);
    let present = 0;
    let late = 0;
    let onCampus = 0;
    for (const st of students) {
      const entry = snap.get(st.id);
      if (!entry) continue;
      const s = statusOf(entry);
      present++;
      if (s.late) late++;
      if (s.on_campus) onCampus++;
    }
    const since = new Date(Date.now() - 86400000).toISOString();
    return {
      date,
      enrolled: students.length,
      present,
      absent: students.length - present,
      late,
      on_campus: onCampus,
      left: present - onCampus,
      recent: db.prepare(`${LOG_SELECT} WHERE a.local_date = ? ORDER BY a.at DESC, a.id DESC LIMIT 30`).all(date).map(decorate),
      devices: db.prepare('SELECT id, name, location, mode, active, last_seen_at FROM devices ORDER BY name').all(),
      unknown_cards: db.prepare('SELECT COUNT(*) AS n FROM unknown_taps').get().n,
      failed_notifications: db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE status = 'failed' AND created_at >= ?").get(since).n,
    };
  }

  function dailyReport(date, { grade, section } = {}) {
    const where = ['active = 1'];
    const params = [];
    if (grade) {
      where.push('grade = ?');
      params.push(grade);
    }
    if (section) {
      where.push('section = ?');
      params.push(section);
    }
    const students = db
      .prepare(`SELECT id, student_no, first_name, last_name, grade, section FROM students WHERE ${where.join(' AND ')}
                ORDER BY grade, section, last_name, first_name`)
      .all(...params);
    const snap = daySnapshot(date);
    const summary = { total: students.length, present: 0, late: 0, absent: 0, on_campus: 0 };
    const rows = students.map((st) => {
      const entry = snap.get(st.id);
      const s = statusOf(entry);
      if (s.status === 'absent') summary.absent++;
      else summary.present++;
      if (s.late) summary.late++;
      if (s.on_campus) summary.on_campus++;
      return {
        ...st,
        student_name: `${st.first_name} ${st.last_name}`,
        status: s.status,
        on_campus: s.on_campus,
        first_in: entry ? entry.first_in : null,
        last_out: entry ? entry.last_out : null,
        taps: entry ? entry.taps : 0,
      };
    });
    return { date, summary, rows };
  }

  function studentToday(studentId) {
    const date = localDate(new Date(), tz());
    const logs = db
      .prepare(`${LOG_SELECT} WHERE a.student_id = ? AND a.local_date = ? ORDER BY a.at, a.id`)
      .all(studentId, date)
      .map(decorate);
    const last = logs[logs.length - 1] || null;
    const firstIn = logs.find((l) => l.direction === 'IN') || null;
    const s = ctx.settings.get();
    return {
      date,
      state: !last ? 'not_arrived' : last.direction === 'IN' ? 'on_campus' : 'left',
      last,
      first_in: firstIn ? firstIn.at : null,
      late: !!firstIn && localHM(new Date(firstIn.at), s.timezone) > s.late_time,
      logs,
    };
  }

  return { tap, manual, list, today, dailyReport, studentToday, findStudentByUid, decorate };
}

module.exports = { createAttendance, LOG_SELECT };
