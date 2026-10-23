'use strict';

const express = require('express');

// Used by gate readers: the phone/tablet app, the ESP32 reader and the USB reader bridge.
module.exports = function deviceRoutes(ctx) {
  const r = express.Router();
  const { auth, settings } = ctx;

  r.get('/device/me', auth.requireDevice, (req, res) => {
    const s = settings.get();
    const d = req.device;
    res.json({
      device: { id: d.id, name: d.name, location: d.location, mode: d.mode },
      school_name: s.school_name,
      timezone: s.timezone,
      server_time: new Date().toISOString(),
    });
  });

  r.post('/tap', auth.requireDevice, (req, res) => {
    res.json(ctx.attendance.tap({ uid: req.body?.uid, at: req.body?.at, device: req.device }));
  });

  return r;
};
