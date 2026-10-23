'use strict';

const crypto = require('node:crypto');

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function text(body, name, { required = false, max = 200, label = name } = {}) {
  const value = body ? body[name] : undefined;
  if (value === undefined || value === null || String(value).trim() === '') {
    if (required) throw new HttpError(400, `${label} is required.`);
    return '';
  }
  if (typeof value !== 'string' && typeof value !== 'number') throw new HttpError(400, `${label} is not valid.`);
  const s = String(value).trim();
  if (s.length > max) throw new HttpError(400, `${label} is too long (${max} characters at most).`);
  return s;
}

function flag(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
}

function id(value, label = 'ID') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${label} is not valid.`);
  return n;
}

function dateParam(value, label = 'Date') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) throw new HttpError(400, `${label} must look like 2026-06-15.`);
  return String(value);
}

// Card UIDs are kept as upper-case hex with no separators: "04:a2:3b:91" -> "04A23B91".
function normalizeUid(raw) {
  return String(raw ?? '').trim().toUpperCase().replace(/[^0-9A-F]/g, '');
}

// USB readers that type like a keyboard often send the 4-byte UID as a 10-digit
// decimal number. Try those as hex in both byte orders as well.
function uidCandidates(raw) {
  const hex = normalizeUid(raw);
  const out = hex ? [hex] : [];
  const digits = String(raw ?? '').trim();
  if (/^\d{8,10}$/.test(digits)) {
    const n = Number(digits);
    if (n <= 0xffffffff) {
      const forward = n.toString(16).toUpperCase().padStart(8, '0');
      const reversed = forward.match(/../g).reverse().join('');
      for (const c of [forward, reversed]) if (!out.includes(c)) out.push(c);
    }
  }
  return out;
}

function validUid(uid) {
  return /^[0-9A-F]{4,32}$/.test(uid);
}

function normalizePhone(raw, countryCode = '63') {
  const input = String(raw ?? '').trim();
  let digits = input.replace(/\D/g, '');
  if (!digits) return '';
  if (input.startsWith('+')) return `+${digits}`;
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  if (digits.startsWith('0')) return `+${countryCode}${digits.slice(1)}`;
  if (digits.startsWith(countryCode) && digits.length >= countryCode.length + 9) return `+${digits}`;
  digits = `${countryCode}${digits}`;
  return `+${digits}`;
}

function validPhone(phone) {
  return /^\+\d{8,15}$/.test(phone);
}

function randomCode(length = 8) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parts(date, tz, options) {
  const out = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: tz, ...options }).formatToParts(date)) out[p.type] = p.value;
  return out;
}

function localDate(date, tz) {
  const p = parts(date, tz, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${p.year}-${p.month}-${p.day}`;
}

function localHM(date, tz) {
  const p = parts(date, tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `${p.hour}:${p.minute}`;
}

function timeLabel(date, tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(date);
}

function dateLabel(date, tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function parseCsv(input) {
  const src = String(input ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  // Stop spreadsheet apps from running cell contents as formulas.
  if (/^[=@\t\r]/.test(s) || /^[+-](?![\d\s()]+$)/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  return `${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

module.exports = {
  HttpError,
  text,
  flag,
  id,
  dateParam,
  normalizeUid,
  uidCandidates,
  validUid,
  normalizePhone,
  validPhone,
  randomCode,
  sha256,
  validTimeZone,
  localDate,
  localHM,
  timeLabel,
  dateLabel,
  addDays,
  parseCsv,
  toCsv,
};
