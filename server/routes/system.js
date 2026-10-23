'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { HttpError, text, flag, id, sha256, normalizePhone, validPhone } = require('../util');
const { hashPassword, checkPasswordStrength } = require('../auth');

const DEVICE_MODES = ['auto', 'in', 'out'];

module.exports = function systemRoutes(ctx) {
  const r = express.Router();
  const { db, auth, settings, config } = ctx;
  const staff = auth.requireUser('admin', 'staff');
  const admin = auth.requireUser('admin');

  // ---- Public ----

  r.get('/public/info', (req, res) => {
    const s = settings.get();
    res.json({ school_name: s.school_name, timezone: s.timezone, late_time: s.late_time, push_public_key: ctx.push.publicKey });
  });

  // ---- Live updates ----

  r.post('/events/ticket', auth.requireUser(), (req, res) => {
    res.json({ ticket: ctx.events.issueTicket(req.user.id) });
  });

  r.get('/events', (req, res) => {
    const userId = ctx.events.redeemTicket(req.query.ticket);
    const user = userId ? db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(userId) : null;
    if (!user) throw new HttpError(401, 'Please sign in again.');
    let filter = null;
    if (user.role === 'parent') {
      const ids = new Set(ctx.childrenOf(user).map((s) => s.id));
      filter = (type, studentId) => type === 'attendance' && ids.has(studentId);
    }
    ctx.events.connect(req, res, filter);
  });

  // ---- Gate readers ----

  const deviceById = db.prepare('SELECT id, name, location, mode, key_hint, active, last_seen_at, created_at FROM devices WHERE id = ?');
  const newKey = () => `dev_${crypto.randomBytes(24).toString('base64url')}`;

  function getDevice(did) {
    const d = deviceById.get(did);
    if (!d) throw new HttpError(404, 'Reader not found.');
    return d;
  }

  function deviceFields(body, existing) {
    const mode = String(body?.mode || (existing ? existing.mode : 'auto'));
    if (!DEVICE_MODES.includes(mode)) throw new HttpError(400, 'Mode must be auto, in or out.');
    return {
      name: text(body, 'name', { required: true, max: 60, label: 'Name' }),
      location: text(body, 'location', { max: 80, label: 'Location' }),
      mode,
      active: flag(body?.active, existing ? !!existing.active : true) ? 1 : 0,
    };
  }

  r.get('/devices', admin, (req, res) => {
    res.json({
      devices: db.prepare('SELECT id, name, location, mode, key_hint, active, last_seen_at, created_at FROM devices ORDER BY name').all(),
    });
  });

  r.post('/devices', admin, (req, res) => {
    const f = deviceFields(req.body);
    const key = newKey();
    const info = db
      .prepare('INSERT INTO devices (name, location, mode, key_hash, key_hint, active) VALUES (?, ?, ?, ?, ?, ?)')
      .run(f.name, f.location, f.mode, sha256(key), key.slice(-4), f.active);
    res.status(201).json({ device: deviceById.get(Number(info.lastInsertRowid)), key });
  });

  r.put('/devices/:id', admin, (req, res) => {
    const device = getDevice(id(req.params.id));
    const f = deviceFields(req.body, device);
    db.prepare('UPDATE devices SET name = ?, location = ?, mode = ?, active = ? WHERE id = ?').run(f.name, f.location, f.mode, f.active, device.id);
    res.json({ device: deviceById.get(device.id) });
  });

  r.post('/devices/:id/key', admin, (req, res) => {
    const device = getDevice(id(req.params.id));
    const key = newKey();
    db.prepare('UPDATE devices SET key_hash = ?, key_hint = ? WHERE id = ?').run(sha256(key), key.slice(-4), device.id);
    res.json({ device: deviceById.get(device.id), key });
  });

  r.delete('/devices/:id', admin, (req, res) => {
    const device = getDevice(id(req.params.id));
    db.prepare('DELETE FROM devices WHERE id = ?').run(device.id);
    res.json({ ok: true });
  });

  // ---- Accounts ----

  const userSelect = `SELECT id, username, name, role, active, created_at, last_login_at,
      (SELECT COUNT(*) FROM push_subscriptions p WHERE p.user_id = users.id) AS push_devices FROM users`;
  const userById = db.prepare(`${userSelect} WHERE id = ?`);
  const activeAdmins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1");

  function getUser(uid) {
    const u = userById.get(uid);
    if (!u) throw new HttpError(404, 'Account not found.');
    return u;
  }

  r.get('/users', admin, (req, res) => {
    const role = ['admin', 'staff', 'parent'].includes(req.query.role) ? req.query.role : null;
    const users = role
      ? db.prepare(`${userSelect} WHERE role = ? ORDER BY name, username`).all(role)
      : db.prepare(`${userSelect} ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'staff' THEN 1 ELSE 2 END, name, username`).all();
    res.json({ users });
  });

  r.post('/users', admin, async (req, res) => {
    const username = text(req.body, 'username', { required: true, max: 60, label: 'Username' });
    if (!/^[A-Za-z0-9._@-]{3,60}$/.test(username)) {
      throw new HttpError(400, 'Username can use letters, numbers and . _ @ - (3 characters or more).');
    }
    const name = text(req.body, 'name', { required: true, max: 100, label: 'Name' });
    const role = String(req.body?.role || 'staff');
    if (!['admin', 'staff'].includes(role)) throw new HttpError(400, 'Role must be admin or staff.');
    checkPasswordStrength(req.body?.password);
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'This username is taken.');
    const info = db
      .prepare('INSERT INTO users (username, name, role, password_hash) VALUES (?, ?, ?, ?)')
      .run(username, name, role, await hashPassword(req.body.password));
    res.status(201).json({ user: getUser(Number(info.lastInsertRowid)) });
  });

  r.put('/users/:id', admin, async (req, res) => {
    const user = getUser(id(req.params.id));
    const name = req.body?.name !== undefined ? text(req.body, 'name', { required: true, max: 100, label: 'Name' }) : user.name;
    let role = user.role;
    if (req.body?.role !== undefined && user.role !== 'parent') {
      role = String(req.body.role);
      if (!['admin', 'staff'].includes(role)) throw new HttpError(400, 'Role must be admin or staff.');
    }
    const active = flag(req.body?.active, !!user.active) ? 1 : 0;
    const isSelf = user.id === req.user.id;
    if (isSelf && (!active || role !== 'admin')) throw new HttpError(400, 'You cannot turn off or demote your own account.');
    if (user.role === 'admin' && user.active && (!active || role !== 'admin') && activeAdmins.get().n <= 1) {
      throw new HttpError(400, 'There must be at least one active administrator.');
    }
    db.prepare('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?').run(name, role, active, user.id);
    if (req.body?.password) {
      checkPasswordStrength(req.body.password);
      db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(
        await hashPassword(req.body.password),
        user.id,
      );
    } else if (!active) {
      db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(user.id);
    }
    res.json({ user: getUser(user.id) });
  });

  r.delete('/users/:id', admin, (req, res) => {
    const user = getUser(id(req.params.id));
    if (user.id === req.user.id) throw new HttpError(400, 'You cannot delete your own account.');
    if (user.role === 'admin' && user.active && activeAdmins.get().n <= 1) {
      throw new HttpError(400, 'There must be at least one active administrator.');
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    res.json({ ok: true });
  });

  // ---- Settings ----

  r.get('/settings', admin, (req, res) => {
    res.json({ settings: settings.get(), sms: ctx.sms.status(), public_url: config.publicUrl });
  });

  r.put('/settings', admin, (req, res) => {
    res.json({ settings: settings.update(req.body || {}) });
  });

  // ---- Notifications ----

  r.get('/notifications', staff, (req, res) => {
    const where = [];
    const params = [];
    if (['pending', 'sent', 'failed'].includes(req.query.status)) {
      where.push('n.status = ?');
      params.push(req.query.status);
    }
    if (['sms', 'push'].includes(req.query.channel)) {
      where.push('n.channel = ?');
      params.push(req.query.channel);
    }
    params.push(Math.min(Number(req.query.limit) || 300, 2000));
    const notifications = db
      .prepare(
        `SELECT n.*, COALESCE(s1.first_name || ' ' || s1.last_name, s2.first_name || ' ' || s2.last_name, '') AS student_name
         FROM notifications n
         LEFT JOIN attendance a ON a.id = n.attendance_id
         LEFT JOIN students s1 ON s1.id = a.student_id
         LEFT JOIN guardians g ON g.id = n.guardian_id
         LEFT JOIN students s2 ON s2.id = g.student_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY n.id DESC LIMIT ?`,
      )
      .all(...params);
    res.json({ notifications });
  });

  r.post('/notifications/:id/resend', staff, async (req, res) => {
    res.json(await ctx.notifier.resend(id(req.params.id)));
  });

  r.post('/notifications/test-sms', admin, async (req, res) => {
    const phone = normalizePhone(text(req.body, 'phone', { required: true, max: 30, label: 'Mobile number' }), config.countryCode);
    if (!validPhone(phone)) throw new HttpError(400, 'Mobile number is not valid.');
    const { id: nid, done } = ctx.notifier.queue({
      channel: 'sms',
      kind: 'test',
      recipient: phone,
      message: `${settings.get().school_name}: This is a test message from the NFC attendance system.`,
    });
    res.json({ notification_id: nid, ...(await done) });
  });

  return r;
};
