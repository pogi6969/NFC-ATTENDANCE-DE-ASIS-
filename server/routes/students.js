'use strict';

const express = require('express');
const { transaction } = require('../db');
const {
  HttpError,
  text,
  flag,
  id,
  normalizeUid,
  validUid,
  normalizePhone,
  validPhone,
  randomCode,
  localDate,
  parseCsv,
} = require('../util');

module.exports = function studentRoutes(ctx) {
  const r = express.Router();
  const { db, auth, config } = ctx;
  const staff = auth.requireUser('admin', 'staff');
  const admin = auth.requireUser('admin');

  const studentById = db.prepare('SELECT * FROM students WHERE id = ?');
  const studentByNo = db.prepare('SELECT * FROM students WHERE student_no = ?');
  const studentByCard = db.prepare('SELECT * FROM students WHERE card_uid = ?');
  const guardianById = db.prepare('SELECT * FROM guardians WHERE id = ?');
  const forgetUnknown = db.prepare('DELETE FROM unknown_taps WHERE card_uid = ?');

  function getStudent(sid) {
    const s = studentById.get(sid);
    if (!s) throw new HttpError(404, 'Student not found.');
    return s;
  }

  function getGuardian(gid) {
    const g = guardianById.get(gid);
    if (!g) throw new HttpError(404, 'Parent or guardian not found.');
    return g;
  }

  function studentFields(body, existing) {
    return {
      student_no: text(body, 'student_no', { required: true, max: 40, label: 'Student number' }),
      first_name: text(body, 'first_name', { required: true, max: 80, label: 'First name' }),
      last_name: text(body, 'last_name', { required: true, max: 80, label: 'Last name' }),
      grade: text(body, 'grade', { max: 40, label: 'Grade' }),
      section: text(body, 'section', { max: 60, label: 'Section' }),
      active: flag(body?.active, existing ? !!existing.active : true) ? 1 : 0,
    };
  }

  function guardianFields(body) {
    const phone = normalizePhone(text(body, 'phone', { required: true, max: 30, label: 'Mobile number' }), config.countryCode);
    if (!validPhone(phone)) throw new HttpError(400, 'Mobile number is not valid.');
    return {
      name: text(body, 'name', { required: true, max: 100, label: 'Name' }),
      relationship: text(body, 'relationship', { max: 40, label: 'Relationship' }),
      phone,
      notify_sms: flag(body?.notify_sms, true) ? 1 : 0,
    };
  }

  // Returns the normalized UID, or throws 409 when another student already has the card.
  function claimCard(raw, studentId, force) {
    const uid = normalizeUid(raw);
    if (!validUid(uid)) throw new HttpError(400, 'Card ID is not valid. It should be letters A-F and numbers, e.g. 04A23B91.');
    const owner = studentByCard.get(uid);
    if (owner && owner.id !== studentId) {
      if (!force) {
        throw new HttpError(409, `This card belongs to ${owner.first_name} ${owner.last_name} (${owner.student_no}).`, {
          owner: { id: owner.id, name: `${owner.first_name} ${owner.last_name}`, student_no: owner.student_no },
        });
      }
      db.prepare('UPDATE students SET card_uid = NULL WHERE id = ?').run(owner.id);
    }
    return uid;
  }

  function baseUrl(req) {
    return config.publicUrl || `${req.protocol}://${req.get('host')}`;
  }

  r.get('/students', staff, (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 80);
    const where = [];
    const params = [localDate(new Date(), ctx.settings.get().timezone)];
    const status = String(req.query.status || 'active');
    if (status === 'active') where.push('s.active = 1');
    if (status === 'inactive') where.push('s.active = 0');
    if (req.query.grade) {
      where.push('s.grade = ?');
      params.push(String(req.query.grade));
    }
    if (req.query.section) {
      where.push('s.section = ?');
      params.push(String(req.query.section));
    }
    if (q) {
      const like = `%${q}%`;
      where.push(
        "((s.first_name || ' ' || s.last_name) LIKE ? OR (s.last_name || ', ' || s.first_name) LIKE ? OR s.student_no LIKE ? OR s.card_uid = ?)",
      );
      params.push(like, like, like, normalizeUid(q) || '-');
    }
    const students = db
      .prepare(
        `SELECT s.*,
          (SELECT COUNT(*) FROM guardians g WHERE g.student_id = s.id) AS guardian_count,
          (SELECT a.direction FROM attendance a WHERE a.student_id = s.id AND a.local_date = ? ORDER BY a.at DESC, a.id DESC LIMIT 1) AS today_last
         FROM students s ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY s.grade, s.section, s.last_name, s.first_name LIMIT 5000`,
      )
      .all(...params);
    res.json({ students });
  });

  r.get('/students/meta', staff, (req, res) => {
    const pick = (col) =>
      db.prepare(`SELECT DISTINCT ${col} AS v FROM students WHERE ${col} <> '' ORDER BY ${col}`).all().map((x) => x.v);
    res.json({ grades: pick('grade'), sections: pick('section') });
  });

  r.post('/students', staff, (req, res) => {
    const f = studentFields(req.body);
    if (studentByNo.get(f.student_no)) throw new HttpError(409, `Student number ${f.student_no} already exists.`);
    const uid = req.body?.card_uid ? claimCard(req.body.card_uid, 0, false) : null;
    const info = db
      .prepare('INSERT INTO students (student_no, first_name, last_name, grade, section, card_uid, active) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(f.student_no, f.first_name, f.last_name, f.grade, f.section, uid, f.active);
    if (uid) forgetUnknown.run(uid);
    res.status(201).json({ student: studentById.get(Number(info.lastInsertRowid)) });
  });

  r.get('/students/:id', staff, (req, res) => {
    const student = getStudent(id(req.params.id));
    res.json({
      student,
      guardians: db.prepare('SELECT * FROM guardians WHERE student_id = ? ORDER BY id').all(student.id),
      today: ctx.attendance.studentToday(student.id),
      recent: ctx.attendance.list({ studentId: student.id, limit: 60 }),
    });
  });

  r.put('/students/:id', staff, (req, res) => {
    const student = getStudent(id(req.params.id));
    const f = studentFields(req.body, student);
    const clash = studentByNo.get(f.student_no);
    if (clash && clash.id !== student.id) throw new HttpError(409, `Student number ${f.student_no} already exists.`);
    db.prepare('UPDATE students SET student_no = ?, first_name = ?, last_name = ?, grade = ?, section = ?, active = ? WHERE id = ?').run(
      f.student_no,
      f.first_name,
      f.last_name,
      f.grade,
      f.section,
      f.active,
      student.id,
    );
    res.json({ student: studentById.get(student.id) });
  });

  r.delete('/students/:id', admin, (req, res) => {
    const student = getStudent(id(req.params.id));
    db.prepare('DELETE FROM students WHERE id = ?').run(student.id);
    res.json({ ok: true });
  });

  r.put('/students/:id/card', staff, (req, res) => {
    const student = getStudent(id(req.params.id));
    const raw = req.body?.uid;
    if (raw === null || raw === undefined || String(raw).trim() === '') {
      db.prepare('UPDATE students SET card_uid = NULL WHERE id = ?').run(student.id);
    } else {
      transaction(db, () => {
        const uid = claimCard(raw, student.id, flag(req.body?.force, false));
        db.prepare('UPDATE students SET card_uid = ? WHERE id = ?').run(uid, student.id);
        forgetUnknown.run(uid);
      });
    }
    res.json({ student: studentById.get(student.id) });
  });

  r.post('/students/import', admin, (req, res) => {
    const csv = String(req.body?.csv ?? '');
    if (!csv.trim()) throw new HttpError(400, 'The file is empty.');
    const rows = parseCsv(csv);
    if (rows.length < 2) throw new HttpError(400, 'The file needs a header row and at least one student.');
    const header = rows[0].map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
    for (const required of ['student_no', 'first_name', 'last_name']) {
      if (!header.includes(required)) throw new HttpError(400, `The header row is missing the column "${required}".`);
    }
    const result = { created: 0, updated: 0, guardians: 0, cards: 0, errors: [] };

    transaction(db, () => {
      rows.slice(1).forEach((row, i) => {
        const get = (name) => {
          const c = header.indexOf(name);
          return c >= 0 ? String(row[c] ?? '').trim() : '';
        };
        try {
          const f = studentFields({
            student_no: get('student_no'),
            first_name: get('first_name'),
            last_name: get('last_name'),
            grade: get('grade'),
            section: get('section'),
          });
          const existing = studentByNo.get(f.student_no);
          let sid;
          if (existing) {
            db.prepare('UPDATE students SET first_name = ?, last_name = ?, grade = ?, section = ? WHERE id = ?').run(
              f.first_name,
              f.last_name,
              f.grade,
              f.section,
              existing.id,
            );
            sid = existing.id;
            result.updated++;
          } else {
            sid = Number(
              db
                .prepare('INSERT INTO students (student_no, first_name, last_name, grade, section) VALUES (?, ?, ?, ?, ?)')
                .run(f.student_no, f.first_name, f.last_name, f.grade, f.section).lastInsertRowid,
            );
            result.created++;
          }

          if (get('card_uid')) {
            const uid = claimCard(get('card_uid'), sid, false);
            db.prepare('UPDATE students SET card_uid = ? WHERE id = ?').run(uid, sid);
            forgetUnknown.run(uid);
            result.cards++;
          }

          if (get('guardian_phone')) {
            const g = guardianFields({
              name: get('guardian_name') || 'Parent/Guardian',
              relationship: get('guardian_relationship'),
              phone: get('guardian_phone'),
            });
            const same = db.prepare('SELECT id FROM guardians WHERE student_id = ? AND phone = ?').get(sid, g.phone);
            if (same) {
              db.prepare('UPDATE guardians SET name = ?, relationship = ? WHERE id = ?').run(g.name, g.relationship, same.id);
            } else {
              db.prepare('INSERT INTO guardians (student_id, name, relationship, phone, notify_sms, invite_code) VALUES (?, ?, ?, ?, 1, ?)').run(
                sid,
                g.name,
                g.relationship,
                g.phone,
                randomCode(),
              );
            }
            result.guardians++;
          }
        } catch (err) {
          result.errors.push({ line: i + 2, error: err.message });
        }
      });
    });
    res.json(result);
  });

  r.post('/students/:id/guardians', staff, (req, res) => {
    const student = getStudent(id(req.params.id));
    const g = guardianFields(req.body);
    const info = db
      .prepare('INSERT INTO guardians (student_id, name, relationship, phone, notify_sms, invite_code) VALUES (?, ?, ?, ?, ?, ?)')
      .run(student.id, g.name, g.relationship, g.phone, g.notify_sms, randomCode());
    res.status(201).json({ guardian: guardianById.get(Number(info.lastInsertRowid)) });
  });

  r.put('/guardians/:id', staff, (req, res) => {
    const guardian = getGuardian(id(req.params.id));
    const g = guardianFields(req.body);
    db.prepare('UPDATE guardians SET name = ?, relationship = ?, phone = ?, notify_sms = ? WHERE id = ?').run(
      g.name,
      g.relationship,
      g.phone,
      g.notify_sms,
      guardian.id,
    );
    res.json({ guardian: guardianById.get(guardian.id) });
  });

  r.delete('/guardians/:id', staff, (req, res) => {
    const guardian = getGuardian(id(req.params.id));
    db.prepare('DELETE FROM guardians WHERE id = ?').run(guardian.id);
    res.json({ ok: true });
  });

  r.post('/guardians/:id/code', staff, (req, res) => {
    const guardian = getGuardian(id(req.params.id));
    db.prepare('UPDATE guardians SET invite_code = ? WHERE id = ?').run(randomCode(), guardian.id);
    res.json({ guardian: guardianById.get(guardian.id) });
  });

  r.post('/guardians/:id/invite', staff, async (req, res) => {
    const guardian = getGuardian(id(req.params.id));
    const student = getStudent(guardian.student_id);
    const { id: notificationId, done } = ctx.notifier.sendInvite(guardian, student, baseUrl(req));
    const result = await done;
    res.json({ notification_id: notificationId, ...result });
  });

  r.get('/cards/unknown', staff, (req, res) => {
    const cards = db
      .prepare(
        `SELECT u.card_uid, u.count, u.first_at, u.last_at, d.name AS device_name
         FROM unknown_taps u LEFT JOIN devices d ON d.id = u.device_id ORDER BY u.last_at DESC LIMIT 500`,
      )
      .all();
    res.json({ cards });
  });

  r.delete('/cards/unknown/:uid', staff, (req, res) => {
    forgetUnknown.run(normalizeUid(req.params.uid));
    res.json({ ok: true });
  });

  r.get('/cards/lookup', staff, (req, res) => {
    const uid = normalizeUid(req.query.uid);
    if (!validUid(uid)) throw new HttpError(400, 'Card ID is not valid.');
    const s = ctx.attendance.findStudentByUid(req.query.uid);
    res.json({
      uid,
      student: s ? { id: s.id, name: `${s.first_name} ${s.last_name}`, student_no: s.student_no, grade: s.grade, section: s.section, active: !!s.active } : null,
    });
  });

  return r;
};
