'use strict';

const express = require('express');
const { transaction } = require('../db');
const { HttpError, text, normalizePhone, validPhone, randomCode } = require('../util');
const { hashPassword, verifyPassword, checkPasswordStrength, createLimiter, publicUser } = require('../auth');

module.exports = function authRoutes(ctx) {
  const r = express.Router();
  const { db, auth, config } = ctx;
  const loginLimit = createLimiter({ windowMs: 15 * 60000, max: 20 });
  const activateLimit = createLimiter({ windowMs: 15 * 60000, max: 10 });

  const userByName = db.prepare('SELECT * FROM users WHERE username = ?');
  const userById = db.prepare('SELECT * FROM users WHERE id = ?');

  r.post('/auth/login', async (req, res) => {
    if (!loginLimit(req.ip)) throw new HttpError(429, 'Too many sign-in attempts. Wait 15 minutes and try again.');
    const username = text(req.body, 'username', { required: true, max: 100, label: 'Username' });
    const password = String(req.body?.password ?? '');
    let user = userByName.get(username);
    if (!user) {
      // Parents sign in with their mobile number in any format: 0917..., 63917..., +63917...
      const phone = normalizePhone(username, config.countryCode);
      if (validPhone(phone)) user = userByName.get(phone);
    }
    if (!user || !user.active || !(await verifyPassword(password, user.password_hash))) {
      throw new HttpError(401, 'Wrong username or password.');
    }
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), user.id);
    res.json({ token: auth.sign(user), user: publicUser(user) });
  });

  r.get('/auth/me', auth.requireUser(), (req, res) => {
    res.json({ user: publicUser(req.user) });
  });

  r.post('/auth/password', auth.requireUser(), async (req, res) => {
    if (!(await verifyPassword(String(req.body?.current ?? ''), req.user.password_hash))) {
      throw new HttpError(400, 'Current password is wrong.');
    }
    checkPasswordStrength(req.body?.next);
    db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(
      await hashPassword(req.body.next),
      req.user.id,
    );
    const user = userById.get(req.user.id);
    res.json({ token: auth.sign(user), user: publicUser(user) });
  });

  // A parent turns the code from the school's text message into an app account.
  // Using a new code again later resets the password.
  r.post('/parent/activate', async (req, res) => {
    if (!activateLimit(req.ip)) throw new HttpError(429, 'Too many attempts. Wait 15 minutes and try again.');
    const phone = normalizePhone(text(req.body, 'phone', { required: true, max: 30, label: 'Mobile number' }), config.countryCode);
    const code = text(req.body, 'code', { required: true, max: 20, label: 'Code' }).toUpperCase().replace(/[^A-Z0-9]/g, '');
    checkPasswordStrength(req.body?.password);

    const guardian = db.prepare('SELECT * FROM guardians WHERE phone = ? AND invite_code = ?').get(phone, code);
    if (!guardian) throw new HttpError(400, 'The number and code do not match. Check the text message from the school.');
    const existing = userByName.get(phone);
    if (existing && existing.role !== 'parent') throw new HttpError(409, 'This number belongs to a staff account.');

    const hash = await hashPassword(req.body.password);
    const userId = transaction(db, () => {
      let uid;
      if (existing) {
        db.prepare(
          "UPDATE users SET password_hash = ?, token_version = token_version + 1, active = 1, name = CASE WHEN name = '' THEN ? ELSE name END WHERE id = ?",
        ).run(hash, guardian.name, existing.id);
        uid = existing.id;
      } else {
        uid = Number(
          db.prepare("INSERT INTO users (username, name, role, password_hash) VALUES (?, ?, 'parent', ?)").run(phone, guardian.name, hash)
            .lastInsertRowid,
        );
      }
      db.prepare('UPDATE guardians SET invite_code = ? WHERE id = ?').run(randomCode(), guardian.id);
      return uid;
    });
    const user = userById.get(userId);
    res.json({ token: auth.sign(user), user: publicUser(user) });
  });

  return r;
};
