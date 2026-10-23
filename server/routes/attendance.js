'use strict';

const express = require('express');
const { HttpError, text, id, dateParam, localDate, timeLabel, toCsv } = require('../util');

module.exports = function attendanceRoutes(ctx) {
  const r = express.Router();
  const { db, auth } = ctx;
  const staff = auth.requireUser('admin', 'staff');
  const admin = auth.requireUser('admin');

  function filters(query) {
    return {
      from: query.from ? dateParam(query.from, 'From') : undefined,
      to: query.to ? dateParam(query.to, 'To') : undefined,
      studentId: query.student_id ? id(query.student_id, 'Student') : undefined,
      direction: ['IN', 'OUT'].includes(query.direction) ? query.direction : undefined,
      grade: query.grade ? String(query.grade) : undefined,
      section: query.section ? String(query.section) : undefined,
      q: String(query.q || '').trim().slice(0, 80),
    };
  }

  function sendCsv(res, name, rows) {
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${name}"`);
    res.send(`﻿${toCsv(rows)}`);
  }

  r.get('/dashboard', staff, (req, res) => {
    res.json(ctx.attendance.today());
  });

  r.get('/attendance', staff, (req, res) => {
    res.json({ logs: ctx.attendance.list({ ...filters(req.query), limit: Number(req.query.limit) || 500 }) });
  });

  r.get('/attendance/export', staff, (req, res) => {
    const f = filters(req.query);
    const logs = ctx.attendance.list({ ...f, limit: 20000 });
    const tz = ctx.settings.get().timezone;
    const rows = [['Date', 'Time', 'In/Out', 'Student No', 'Last name', 'First name', 'Grade', 'Section', 'Gate', 'Method', 'Recorded by', 'Note']];
    for (const l of logs) {
      rows.push([
        l.local_date,
        timeLabel(new Date(l.at), tz),
        l.direction,
        l.student_no,
        l.last_name,
        l.first_name,
        l.grade,
        l.section,
        l.device_name || '',
        l.method,
        l.recorded_by_name || '',
        l.note,
      ]);
    }
    sendCsv(res, `attendance_${f.from || 'all'}_${f.to || 'all'}.csv`, rows);
  });

  r.post('/attendance/manual', staff, (req, res) => {
    const log = ctx.attendance.manual({
      studentId: id(req.body?.student_id, 'Student'),
      direction: req.body?.direction,
      at: req.body?.at,
      user: req.user,
      note: text(req.body, 'note', { max: 200, label: 'Note' }),
    });
    res.status(201).json({ log });
  });

  r.delete('/attendance/:id', admin, (req, res) => {
    const info = db.prepare('DELETE FROM attendance WHERE id = ?').run(id(req.params.id));
    if (!info.changes) throw new HttpError(404, 'Record not found.');
    res.json({ ok: true });
  });

  r.get('/reports/daily', staff, (req, res) => {
    const tz = ctx.settings.get().timezone;
    const date = req.query.date ? dateParam(req.query.date) : localDate(new Date(), tz);
    const report = ctx.attendance.dailyReport(date, {
      grade: req.query.grade ? String(req.query.grade) : undefined,
      section: req.query.section ? String(req.query.section) : undefined,
    });
    if (req.query.format !== 'csv') return res.json(report);

    const rows = [['Student No', 'Last name', 'First name', 'Grade', 'Section', 'Status', 'First in', 'Last out', 'Taps']];
    for (const row of report.rows) {
      rows.push([
        row.student_no,
        row.last_name,
        row.first_name,
        row.grade,
        row.section,
        row.status,
        row.first_in ? timeLabel(new Date(row.first_in), tz) : '',
        row.last_out ? timeLabel(new Date(row.last_out), tz) : '',
        row.taps,
      ]);
    }
    sendCsv(res, `daily_report_${date}.csv`, rows);
  });

  return r;
};
