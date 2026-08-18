'use strict';

/**
 * Tiny HTTP server. Its ONLY job is to answer the pings from cron-job.org
 * (or UptimeRobot) every 10-14 minutes so Render's free tier never spins
 * the service down. Render spins down after ~15 min without inbound traffic.
 */
const http = require('http');

function startKeepAliveServer() {
  const port = Number(process.env.PORT) || 10000;
  const server = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0];
    if (url === '/' || url === '/health' || url === '/ping') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('alive');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(`[keepalive] listening on :${port}`);
  });
  server.on('error', (e) => console.error('[keepalive] error:', e.message));
  return server;
}

module.exports = { startKeepAliveServer };
