'use strict';

const { loadConfig } = require('./config');
const { createServer } = require('./app');

async function main() {
  const config = loadConfig();
  const { app, ctx } = await createServer(config);
  const server = app.listen(config.port, () => {
    console.log(`NFC Attendance is running on http://localhost:${config.port}`);
    console.log(`  Website:   http://localhost:${config.port}/`);
    console.log(`  Dashboard: http://localhost:${config.port}/admin/`);
    console.log(`  App:       http://localhost:${config.port}/app/`);
    console.log(`  Text messages: ${ctx.sms.status().provider}`);
  });

  const shutdown = () => {
    server.close();
    ctx.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
