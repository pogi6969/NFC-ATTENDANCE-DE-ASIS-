'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../server/config');
const { createServer } = require('../server/app');
const { normalizeUid, uidCandidates, normalizePhone, parseCsv, toCsv } = require('../server/util');

async function start() {
  const config = loadConfig({ skipEnvFile: true, dbPath: ':memory:', adminPassword: 'admin12345', quiet: true, sms: { provider: 'console' } });
  const { app, ctx } = await createServer(config);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function call(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
  }
  const login = await call('POST', '/auth/login', { username: 'admin', password: 'admin12345' });
  const admin = { Authorization: `Bearer ${login.body.token}` };
  return {
    ctx,
    call,
    admin,
    close() {
      server.close();
      ctx.close();
    },
  };
}

test('helpers', () => {
  assert.equal(normalizeUid('04:a2:3b:91'), '04A23B91');
  assert.deepEqual(uidCandidates('0077740945'), ['0077740945', '04A23B91', '913BA204']);
  assert.equal(normalizePhone('0917 123 4567'), '+639171234567');
  assert.equal(normalizePhone('639171234567'), '+639171234567');
  assert.equal(normalizePhone('+1 415 555 0100'), '+14155550100');
  assert.deepEqual(parseCsv('a,b\n"x, y","he said ""hi"""\n'), [['a', 'b'], ['x, y', 'he said "hi"']]);
  assert.equal(toCsv([['=SUM(A1)', '+639171234567']]), "'=SUM(A1),+639171234567\r\n");
});

test('tap in, duplicate, tap out, unknown card, parent texts', async (t) => {
  const s = await start();
  t.after(() => s.close());

  const student = await s.call('POST', '/students', { student_no: 'S1', first_name: 'Juan', last_name: 'Dela Cruz', grade: '10', section: 'Rizal', card_uid: '04:a2:3b:91' }, s.admin);
  assert.equal(student.status, 201);
  const sid = student.body.student.id;
  const guardian = await s.call('POST', `/students/${sid}/guardians`, { name: 'Maria', phone: '09171234567' }, s.admin);
  assert.equal(guardian.body.guardian.phone, '+639171234567');
  const device = await s.call('POST', '/devices', { name: 'Main Gate' }, s.admin);
  const gate = { 'X-Device-Key': device.body.key };

  const first = await s.call('POST', '/tap', { uid: '04A23B91' }, gate);
  assert.equal(first.body.status, 'ok');
  assert.equal(first.body.direction, 'IN');

  const again = await s.call('POST', '/tap', { uid: '04A23B91' }, gate);
  assert.equal(again.body.status, 'duplicate');

  await s.call('PUT', '/settings', { tap_cooldown_seconds: 0 }, s.admin);
  const out = await s.call('POST', '/tap', { uid: '04a23b91' }, gate);
  assert.equal(out.body.direction, 'OUT');

  const unknown = await s.call('POST', '/tap', { uid: 'DEADBEEF' }, gate);
  assert.equal(unknown.body.status, 'unknown');
  const cards = await s.call('GET', '/cards/unknown', undefined, s.admin);
  assert.equal(cards.body.cards[0].card_uid, 'DEADBEEF');

  const badKey = await s.call('POST', '/tap', { uid: '04A23B91' }, { 'X-Device-Key': 'nope' });
  assert.equal(badKey.status, 401);

  await s.ctx.notifier.flush();
  const texts = s.ctx.sms.outbox.map((m) => m.message);
  assert.equal(texts.length, 2);
  assert.match(texts[0], /Juan Dela Cruz entered the campus at .* \(Main Gate\)/);
  assert.match(texts[1], /left the campus/);
  const log = await s.call('GET', '/notifications', undefined, s.admin);
  assert.ok(log.body.notifications.every((n) => n.status === 'sent'));

  const report = await s.call('GET', '/reports/daily', undefined, s.admin);
  assert.equal(report.body.summary.present, 1);
  assert.equal(report.body.rows[0].on_campus, false);
});

test('gate mode, offline taps and manual entry', async (t) => {
  const s = await start();
  t.after(() => s.close());
  await s.call('PUT', '/settings', { tap_cooldown_seconds: 0 }, s.admin);
  const { body } = await s.call('POST', '/students', { student_no: 'S2', first_name: 'Ana', last_name: 'Santos', card_uid: '04B7C2D3' }, s.admin);
  const entrance = await s.call('POST', '/devices', { name: 'Entrance', mode: 'in' }, s.admin);
  const gate = { 'X-Device-Key': entrance.body.key };

  assert.equal((await s.call('POST', '/tap', { uid: '04B7C2D3' }, gate)).body.direction, 'IN');
  assert.equal((await s.call('POST', '/tap', { uid: '04B7C2D3' }, gate)).body.direction, 'IN');

  const offline = await s.call('POST', '/tap', { uid: '04B7C2D3', at: Math.floor(Date.now() / 1000) - 3600 }, gate);
  assert.equal(offline.status, 200);
  assert.ok(new Date(offline.body.at) < new Date(Date.now() - 3500 * 1000));

  const tooOld = await s.call('POST', '/tap', { uid: '04B7C2D3', at: new Date(Date.now() - 9 * 86400000).toISOString() }, gate);
  assert.equal(tooOld.status, 400);

  const manual = await s.call('POST', '/attendance/manual', { student_id: body.student.id, direction: 'OUT', note: 'Fetched early' }, s.admin);
  assert.equal(manual.status, 201);
  assert.equal(manual.body.log.method, 'manual');

  const csv = await s.call('GET', '/attendance/export', undefined, s.admin);
  assert.match(csv.body, /Fetched early/);
});

test('parent activates with the texted code and sees only their child', async (t) => {
  const s = await start();
  t.after(() => s.close());
  const a = await s.call('POST', '/students', { student_no: 'P1', first_name: 'Kyla', last_name: 'Ramos' }, s.admin);
  await s.call('POST', '/students', { student_no: 'P2', first_name: 'Other', last_name: 'Kid' }, s.admin);
  const g = await s.call('POST', `/students/${a.body.student.id}/guardians`, { name: 'Ben', phone: '09170000008' }, s.admin);

  const invite = await s.call('POST', `/guardians/${g.body.guardian.id}/invite`, undefined, s.admin);
  assert.equal(invite.body.ok, true);
  assert.match(s.ctx.sms.outbox.at(-1).message, new RegExp(g.body.guardian.invite_code));

  const wrong = await s.call('POST', '/parent/activate', { phone: '09170000008', code: 'WRONG123', password: 'parentpass' });
  assert.equal(wrong.status, 400);
  const ok = await s.call('POST', '/parent/activate', { phone: '0917 000 0008', code: g.body.guardian.invite_code, password: 'parentpass' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.role, 'parent');

  const login = await s.call('POST', '/auth/login', { username: '09170000008', password: 'parentpass' });
  const parent = { Authorization: `Bearer ${login.body.token}` };
  const kids = await s.call('GET', '/parent/children', undefined, parent);
  assert.deepEqual(kids.body.children.map((c) => c.first_name), ['Kyla']);
  assert.equal(kids.body.children[0].today.state, 'not_arrived');

  assert.equal((await s.call('GET', '/students', undefined, parent)).status, 403);
  assert.equal((await s.call('GET', `/parent/children/${a.body.student.id + 1}/logs`, undefined, parent)).status, 404);

  const reuse = await s.call('POST', '/parent/activate', { phone: '09170000008', code: g.body.guardian.invite_code, password: 'another1' });
  assert.equal(reuse.status, 400);
});

test('CSV import and card conflicts', async (t) => {
  const s = await start();
  t.after(() => s.close());
  const csv = [
    'student_no,first_name,last_name,grade,section,card_uid,guardian_name,guardian_phone',
    '1001,Juan,Cruz,Grade 7,A,04AA0001,Maria Cruz,09171110001',
    '1002,Ana,Lim,Grade 7,A,04AA0001,,',
    '1003,,NoFirst,Grade 7,A,,,',
  ].join('\n');
  const r = await s.call('POST', '/students/import', { csv }, s.admin);
  assert.equal(r.body.created, 2);
  assert.equal(r.body.guardians, 1);
  assert.equal(r.body.errors.length, 2);

  const list = await s.call('GET', '/students?q=Lim', undefined, s.admin);
  const ana = list.body.students[0];
  const conflict = await s.call('PUT', `/students/${ana.id}/card`, { uid: '04AA0001' }, s.admin);
  assert.equal(conflict.status, 409);
  const moved = await s.call('PUT', `/students/${ana.id}/card`, { uid: '04AA0001', force: true }, s.admin);
  assert.equal(moved.body.student.card_uid, '04AA0001');
});
