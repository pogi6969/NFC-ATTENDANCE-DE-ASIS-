'use strict';

const { HttpError, timeLabel, dateLabel } = require('./util');

function render(template, vars) {
  return template.replace(/\{(\w+)\}/g, (match, key) => (Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match));
}

// Text messages and app notifications to parents. Every message is saved in the
// notifications table with its delivery status so the school can see and resend it.
function createNotifier(ctx) {
  const { db } = ctx;
  const inflight = new Set();

  const insert = db.prepare(`
    INSERT INTO notifications (attendance_id, guardian_id, user_id, channel, kind, recipient, title, message, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`);
  const markSent = db.prepare("UPDATE notifications SET status = 'sent', error = '', sent_at = ? WHERE id = ?");
  const markFailed = db.prepare("UPDATE notifications SET status = 'failed', error = ? WHERE id = ?");
  const markPending = db.prepare("UPDATE notifications SET status = 'pending', error = '' WHERE id = ?");
  const byId = db.prepare('SELECT * FROM notifications WHERE id = ?');
  const guardiansOf = db.prepare('SELECT * FROM guardians WHERE student_id = ? ORDER BY id');
  const parentsOf = db.prepare(`
    SELECT DISTINCT u.* FROM users u JOIN guardians g ON g.phone = u.username
    WHERE g.student_id = ? AND u.role = 'parent' AND u.active = 1`);

  function track(promise) {
    inflight.add(promise);
    promise.finally(() => inflight.delete(promise));
    return promise;
  }

  async function flush() {
    while (inflight.size) await Promise.allSettled([...inflight]);
  }

  function deliver(row) {
    return track(
      (async () => {
        try {
          if (row.channel === 'sms') {
            await ctx.sms.send(row.recipient, row.message);
          } else {
            await ctx.push.sendToUser(row.user_id, {
              title: row.title || ctx.settings.get().school_name,
              body: row.message,
              url: '/app/',
              tag: row.attendance_id ? `attendance-${row.attendance_id}` : `notice-${row.id}`,
            });
          }
          markSent.run(new Date().toISOString(), row.id);
          return { ok: true };
        } catch (err) {
          const error = String(err?.message || err).slice(0, 500);
          markFailed.run(error, row.id);
          if (!ctx.config.quiet) console.warn(`[notify] ${row.channel} to ${row.recipient} failed: ${error}`);
          return { ok: false, error };
        }
      })(),
    );
  }

  function queue({ attendanceId = null, guardianId = null, userId = null, channel, kind = 'attendance', recipient, title = '', message }) {
    const info = insert.run(attendanceId, guardianId, userId, channel, kind, recipient, title, message);
    const row = byId.get(Number(info.lastInsertRowid));
    return { id: row.id, done: deliver(row) };
  }

  function attendanceVars(log, student, gate) {
    const s = ctx.settings.get();
    const at = new Date(log.at);
    return {
      school: s.school_name,
      student: `${student.first_name} ${student.last_name}`,
      first_name: student.first_name,
      last_name: student.last_name,
      grade: student.grade,
      section: student.section,
      time: timeLabel(at, s.timezone),
      date: dateLabel(at, s.timezone),
      gate,
      action: log.direction === 'IN' ? 'entered' : 'left',
    };
  }

  function onAttendance(log, student, gate) {
    const s = ctx.settings.get();
    if (log.direction === 'IN' && !s.notify_on_in) return;
    if (log.direction === 'OUT' && !s.notify_on_out) return;

    const message = render(log.direction === 'IN' ? s.template_in : s.template_out, attendanceVars(log, student, gate));
    const title = `${student.first_name} ${log.direction === 'IN' ? 'entered' : 'left'} the campus`;

    if (s.sms_enabled) {
      const phones = new Set();
      for (const g of guardiansOf.all(student.id)) {
        if (!g.notify_sms || phones.has(g.phone)) continue;
        phones.add(g.phone);
        queue({ attendanceId: log.id, guardianId: g.id, channel: 'sms', recipient: g.phone, message });
      }
    }
    if (s.push_enabled) {
      for (const user of parentsOf.all(student.id)) {
        if (!ctx.push.hasSubscribers(user.id)) continue;
        queue({ attendanceId: log.id, userId: user.id, channel: 'push', recipient: user.username, title, message });
      }
    }
  }

  function inviteMessage(guardian, student, baseUrl) {
    const school = ctx.settings.get().school_name;
    const local = guardian.phone.startsWith(`+${ctx.config.countryCode}`)
      ? `0${guardian.phone.slice(ctx.config.countryCode.length + 1)}`
      : guardian.phone;
    return (
      `${school}: Get a notice each time ${student.first_name} enters or leaves the campus. ` +
      `Open ${baseUrl}/app/ , choose Parent, and activate with your number ${local} and code ${guardian.invite_code}.`
    );
  }

  function sendInvite(guardian, student, baseUrl) {
    return queue({
      guardianId: guardian.id,
      channel: 'sms',
      kind: 'invite',
      recipient: guardian.phone,
      message: inviteMessage(guardian, student, baseUrl),
    });
  }

  function resend(id) {
    const row = byId.get(id);
    if (!row) throw new HttpError(404, 'Notification not found.');
    markPending.run(id);
    return deliver(row);
  }

  return { onAttendance, queue, sendInvite, inviteMessage, resend, flush, render };
}

module.exports = { createNotifier, render };
