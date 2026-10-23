'use strict';

const express = require('express');
const { HttpError, id, localDate, addDays } = require('../util');

module.exports = function parentRoutes(ctx) {
  const r = express.Router();
  const { auth, settings } = ctx;
  const parent = auth.requireUser('parent');
  const signedIn = auth.requireUser();

  r.get('/parent/children', parent, (req, res) => {
    const children = ctx.childrenOf(req.user).map((s) => ({
      id: s.id,
      name: `${s.first_name} ${s.last_name}`,
      first_name: s.first_name,
      last_name: s.last_name,
      student_no: s.student_no,
      grade: s.grade,
      section: s.section,
      has_card: !!s.card_uid,
      today: ctx.attendance.studentToday(s.id),
    }));
    res.json({ children });
  });

  r.get('/parent/children/:id/logs', parent, (req, res) => {
    const sid = id(req.params.id);
    if (!ctx.childrenOf(req.user).some((s) => s.id === sid)) throw new HttpError(404, 'Student not found.');
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 180);
    const from = addDays(localDate(new Date(), settings.get().timezone), -(days - 1));
    res.json({ logs: ctx.attendance.list({ studentId: sid, from, limit: 5000 }) });
  });

  r.post('/push/subscribe', signedIn, (req, res) => {
    ctx.push.subscribe(req.user.id, req.body?.subscription);
    res.json({ ok: true });
  });

  r.post('/push/unsubscribe', signedIn, (req, res) => {
    ctx.push.unsubscribe(req.user.id, req.body?.endpoint);
    res.json({ ok: true });
  });

  r.post('/push/test', signedIn, async (req, res) => {
    const { id: nid, done } = ctx.notifier.queue({
      userId: req.user.id,
      channel: 'push',
      kind: 'test',
      recipient: req.user.username,
      title: settings.get().school_name,
      message: 'Notifications are on. You will get one each time your child taps in or out of the campus.',
    });
    res.json({ notification_id: nid, ...(await done) });
  });

  return r;
};
