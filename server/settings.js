'use strict';

const { HttpError, validTimeZone } = require('./util');

const DEFAULTS = {
  school_name: 'De Asis',
  timezone: 'Asia/Manila',
  late_time: '07:30',
  tap_cooldown_seconds: '60',
  notify_on_in: '1',
  notify_on_out: '1',
  sms_enabled: '1',
  push_enabled: '1',
  template_in: '{school}: {student} entered the campus at {time} ({gate}), {date}.',
  template_out: '{school}: {student} left the campus at {time} ({gate}), {date}.',
};

const BOOLEANS = ['notify_on_in', 'notify_on_out', 'sms_enabled', 'push_enabled'];

function createSettings(db, config) {
  const defaults = { ...DEFAULTS, timezone: config.timezone };
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  let cache = null;

  function raw() {
    if (!cache) {
      cache = { ...defaults };
      for (const row of db.prepare('SELECT key, value FROM settings').all()) cache[row.key] = row.value;
    }
    return cache;
  }

  function set(key, value) {
    upsert.run(key, String(value));
    raw()[key] = String(value);
  }

  // Typed view of the school settings (internal keys starting with "_" are left out).
  function get() {
    const r = raw();
    const out = {};
    for (const key of Object.keys(DEFAULTS)) out[key] = r[key];
    for (const key of BOOLEANS) out[key] = r[key] === '1';
    out.tap_cooldown_seconds = Number(r.tap_cooldown_seconds) || 0;
    return out;
  }

  function update(input) {
    const changes = {};
    const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
    const str = (k, label, max) => {
      const v = String(input[k] ?? '').trim();
      if (!v) throw new HttpError(400, `${label} is required.`);
      if (v.length > max) throw new HttpError(400, `${label} is too long (${max} characters at most).`);
      return v;
    };
    if (has('school_name')) changes.school_name = str('school_name', 'School name', 80);
    if (has('timezone')) {
      const tz = str('timezone', 'Time zone', 64);
      if (!validTimeZone(tz)) throw new HttpError(400, 'Time zone is not valid, e.g. Asia/Manila.');
      changes.timezone = tz;
    }
    if (has('late_time')) {
      const v = str('late_time', 'Late after', 5);
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new HttpError(400, 'Late after must be a time like 07:30.');
      changes.late_time = v;
    }
    if (has('tap_cooldown_seconds')) {
      const n = Number(input.tap_cooldown_seconds);
      if (!Number.isInteger(n) || n < 0 || n > 3600) throw new HttpError(400, 'Cooldown must be 0 to 3600 seconds.');
      changes.tap_cooldown_seconds = String(n);
    }
    for (const key of BOOLEANS) {
      if (has(key)) changes[key] = input[key] === true || input[key] === '1' || input[key] === 1 ? '1' : '0';
    }
    if (has('template_in')) changes.template_in = str('template_in', 'Entry message', 320);
    if (has('template_out')) changes.template_out = str('template_out', 'Exit message', 320);
    for (const [k, v] of Object.entries(changes)) set(k, v);
    return get();
  }

  return {
    get,
    update,
    set,
    secret: (key) => raw()[key] || '',
  };
}

module.exports = { createSettings, DEFAULTS };
