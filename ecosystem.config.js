const path = require('path');
const fs = require('fs');

// Dynamically read ADMIN_TOKEN from app/.dev.vars so it isn't hardcoded in git
let adminToken = '';
try {
  const devVarsPath = path.join(__dirname, 'app', '.dev.vars');
  const devVars = fs.readFileSync(devVarsPath, 'utf8');
  const match = devVars.match(/^ADMIN_TOKEN="?([^"\n]+)"?/m);
  if (match) {
    adminToken = match[1];
  }
} catch (e) {
  console.warn('Could not read ADMIN_TOKEN from app/.dev.vars', e.message);
}

module.exports = {
  apps: [
    // Mac scout / senate-relay / senate-tunnel retired 2026-09-09 (#2351).
    // Coolify owns Senate relay/tunnel; residential egress is the little
    // physical-device / WireGuard proxy via RESIDENTIAL_PROXY_URL (Infisical).
    // See docs/rollouts/2026-09-09-retire-mac-scout-folder.md.
    {
      name: 'vision-worker',
      script: 'worker.py',
      interpreter: '/usr/bin/python3',
      cwd: path.join(__dirname, 'services', 'vision-worker'),
      env: {
        CONGRESS_TRADE_API_URL: 'http://localhost:8787',
        WORKER_ID: 'local_mac_1',
        POLL_INTERVAL_SEC: '30',
        HEARTBEAT_INTERVAL_SEC: '60',
        ADMIN_TOKEN: adminToken
      },
      log_date_format: 'YYYY-MM-DD HH:mm Z',
      out_file: '/Users/jay/Library/Logs/com.congress.trade.vision-worker.log',
      error_file: '/Users/jay/Library/Logs/com.congress.trade.vision-worker.err.log',
      merge_logs: true
    }
  ]
};
