'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { openDatabase } = require('./db');
const { createSettings } = require('./settings');
const { createEventHub } = require('./events');
const { createSms } = require('./sms');
const { createPush } = require('./push');
const { createNotifier } = require('./notify');
const { createAttendance } = require('./attendance');
const { createAuth, hashPassword } = require('./auth');
const { HttpError } = require('./util');

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

async function ensureAdmin(ctx) {
  const { db, config } = ctx;
  if (db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get()) return;
  const password = config.adminPassword || crypto.randomBytes(9).toString('base64url');
  db.prepare("INSERT INTO users (username, name, role, password_hash) VALUES (?, 'Administrator', 'admin', ?)").run(
    config.adminUsername,
    await hashPassword(password),
  );
  if (!config.quiet) {
    console.log('\n  Administrator account created');
    console.log(`    username: ${config.adminUsername}`);
    console.log(`    password: ${config.adminPassword ? '(from ADMIN_PASSWORD)' : password}`);
    console.log('  Sign in at /admin/ and change the password under Settings.\n');
  }
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server.' : err.message, ...(err.extra || {}) });
}

async function createServer(config) {
  const db = openDatabase(config.dbPath);
  const ctx = { config, db };
  ctx.settings = createSettings(db, config);
  ctx.events = createEventHub();
  ctx.sms = createSms(config);
  ctx.push = createPush(ctx);
  ctx.notifier = createNotifier(ctx);
  ctx.attendance = createAttendance(ctx);
  ctx.auth = createAuth(ctx);

  const childrenStmt = db.prepare(`
    SELECT DISTINCT s.* FROM students s JOIN guardians g ON g.student_id = s.id
    WHERE g.phone = ? AND s.active = 1 ORDER BY s.first_name, s.last_name`);
  ctx.childrenOf = (user) => childrenStmt.all(user.username);

  await ensureAdmin(ctx);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
    });
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.use('/api', express.json({ limit: '6mb' }));
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(
    '/api',
    require('./routes/auth')(ctx),
    require('./routes/device')(ctx),
    require('./routes/students')(ctx),
    require('./routes/attendance')(ctx),
    require('./routes/system')(ctx),
    require('./routes/parent')(ctx),
  );
  app.use('/api', () => {
    throw new HttpError(404, 'Not found.');
  });

  app.use(express.static(config.publicDir, { extensions: ['html'] }));
  app.use(errorHandler);

  ctx.close = () => {
    ctx.events.close();
    db.close();
  };
  return { app, ctx };
}

module.exports = { createServer };
