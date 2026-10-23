'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { HttpError, sha256 } = require('./util');

const scrypt = promisify(crypto.scrypt);

const TOKEN_DAYS = { admin: 7, staff: 7, parent: 180 };

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(String(password), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(key, expected);
}

function checkPasswordStrength(password) {
  if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  if (password.length > 200) throw new HttpError(400, 'Password is too long.');
}

function createLimiter({ windowMs, max }) {
  const hits = new Map();
  return function allow(key) {
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.reset < now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    if (hits.size > 10000) {
      for (const [k, e] of hits) if (e.reset < now) hits.delete(k);
    }
    return entry.count <= max;
  };
}

function createAuth(ctx) {
  const { db, settings, config } = ctx;

  let secret = config.appSecret || settings.secret('_app_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('base64url');
    settings.set('_app_secret', secret);
  }

  const userById = db.prepare('SELECT * FROM users WHERE id = ?');
  const deviceByKey = db.prepare('SELECT * FROM devices WHERE key_hash = ?');
  const touchDevice = db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?');

  const mac = (body) => crypto.createHmac('sha256', secret).update(body).digest('base64url');

  function sign(user) {
    const days = TOKEN_DAYS[user.role] || 7;
    const payload = { u: user.id, v: user.token_version, e: Math.floor(Date.now() / 1000) + days * 86400 };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${mac(body)}`;
  }

  function verify(token) {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const expected = Buffer.from(mac(body));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    let payload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    } catch {
      return null;
    }
    if (!payload || payload.e < Date.now() / 1000) return null;
    const user = userById.get(payload.u);
    if (!user || !user.active || user.token_version !== payload.v) return null;
    return user;
  }

  function userFromRequest(req) {
    const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    return match ? verify(match[1]) : null;
  }

  function requireUser(...roles) {
    return (req, res, next) => {
      const user = userFromRequest(req);
      if (!user) throw new HttpError(401, 'Please sign in again.');
      if (roles.length && !roles.includes(user.role)) throw new HttpError(403, 'Your account cannot do this.');
      req.user = user;
      next();
    };
  }

  function requireDevice(req, res, next) {
    const key = req.get('x-device-key') || '';
    const device = key ? deviceByKey.get(sha256(key)) : null;
    if (!device || !device.active) throw new HttpError(401, 'This reader is not paired. Pair it again from the dashboard.');
    touchDevice.run(new Date().toISOString(), device.id);
    req.device = device;
    next();
  }

  return { sign, verify, requireUser, requireDevice };
}

function publicUser(user) {
  return { id: user.id, username: user.username, name: user.name, role: user.role, active: !!user.active };
}

module.exports = { createAuth, hashPassword, verifyPassword, checkPasswordStrength, createLimiter, publicUser };
