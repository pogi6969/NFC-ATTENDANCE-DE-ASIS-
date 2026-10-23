'use strict';

const crypto = require('node:crypto');

// Live updates for the dashboard and the parent app (Server-Sent Events).
function createEventHub() {
  const clients = new Set();
  const tickets = new Map();

  const heartbeat = setInterval(() => {
    for (const c of clients) c.res.write(': ping\n\n');
    const now = Date.now();
    for (const [t, entry] of tickets) if (entry.expires < now) tickets.delete(t);
  }, 25000);
  heartbeat.unref();

  // EventSource cannot send headers, so the browser trades its login for a short single-use ticket.
  function issueTicket(userId) {
    const ticket = crypto.randomBytes(24).toString('base64url');
    tickets.set(ticket, { userId, expires: Date.now() + 60000 });
    return ticket;
  }

  function redeemTicket(ticket) {
    const entry = tickets.get(String(ticket || ''));
    tickets.delete(String(ticket || ''));
    return entry && entry.expires >= Date.now() ? entry.userId : null;
  }

  function connect(req, res, filter) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 5000\n\n');
    const client = { res, filter };
    clients.add(client);
    req.on('close', () => clients.delete(client));
  }

  function broadcast(type, data, studentId = null) {
    const message = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) {
      if (!c.filter || c.filter(type, studentId)) c.res.write(message);
    }
  }

  function close() {
    clearInterval(heartbeat);
    for (const c of clients) c.res.end();
    clients.clear();
  }

  return { issueTicket, redeemTicket, connect, broadcast, close, get size() { return clients.size; } };
}

module.exports = { createEventHub };
