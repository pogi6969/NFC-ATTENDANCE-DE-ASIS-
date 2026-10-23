'use strict';

const webpush = require('web-push');
const { HttpError } = require('./util');

function createPush(ctx) {
  const { config, settings, db } = ctx;

  let publicKey = config.vapid.publicKey;
  let privateKey = config.vapid.privateKey;
  if (!publicKey || !privateKey) {
    publicKey = settings.secret('_vapid_public');
    privateKey = settings.secret('_vapid_private');
    if (!publicKey || !privateKey) {
      const keys = webpush.generateVAPIDKeys();
      publicKey = keys.publicKey;
      privateKey = keys.privateKey;
      settings.set('_vapid_public', publicKey);
      settings.set('_vapid_private', privateKey);
    }
  }
  const vapidDetails = { subject: config.vapid.subject, publicKey, privateKey };

  const upsert = db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`);
  const byUser = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?');
  const remove = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?');
  const removeForUser = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?');

  function subscribe(userId, sub) {
    const endpoint = sub && typeof sub.endpoint === 'string' ? sub.endpoint : '';
    const keys = (sub && sub.keys) || {};
    if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') {
      throw new HttpError(400, 'This browser sent an invalid notification subscription.');
    }
    upsert.run(userId, endpoint, keys.p256dh.slice(0, 200), keys.auth.slice(0, 100));
  }

  function unsubscribe(userId, endpoint) {
    removeForUser.run(String(endpoint || ''), userId);
  }

  function hasSubscribers(userId) {
    return byUser.all(userId).length > 0;
  }

  async function sendToUser(userId, payload) {
    const subs = byUser.all(userId);
    if (!subs.length) throw new Error('No phone has notifications turned on for this account.');
    let delivered = 0;
    let lastError = null;
    for (const s of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload),
          { vapidDetails, TTL: 6 * 3600, urgency: 'high', timeout: 15000 },
        );
        delivered++;
      } catch (err) {
        lastError = err;
        if (err.statusCode === 404 || err.statusCode === 410) remove.run(s.endpoint);
      }
    }
    if (!delivered) throw new Error(lastError?.body || lastError?.message || 'Push failed.');
    return delivered;
  }

  return { publicKey, subscribe, unsubscribe, hasSubscribers, sendToUser };
}

module.exports = { createPush };
