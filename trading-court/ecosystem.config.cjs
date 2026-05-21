// ============================================================================
// PM2 process configuration for Trading Court Pro v4.1
//
// Usage:
//   pm2 start ecosystem.config.cjs
//   pm2 save
//   pm2 startup    # then run the command it outputs
//
// Logs land in ./logs/ — make sure the directory exists (mkdir -p logs).
// ============================================================================
module.exports = {
  apps: [
    {
      name: "trading-court-pro",
      script: "dist/server.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      kill_timeout: 5000,
      env: {
        NODE_ENV: "production",
        PORT: 3555,
      },
      error_file: "logs/error.log",
      out_file: "logs/out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
    },
    // ─── Outcome tracker (cron-style runner) ──────────────────────────────
    // Runs every 4 hours, exits with code 0. PM2 cron_restart re-spawns it.
    // It reads verdict_log.jsonl and writes outcome_log.jsonl.
    {
      name: "trading-court-tracker",
      script: "dist/cron/runOutcomeTracker.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: false,
      cron_restart: "0 */4 * * *",
      watch: false,
      max_memory_restart: "256M",
      env: {
        NODE_ENV: "production",
      },
      error_file: "logs/tracker-error.log",
      out_file: "logs/tracker-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
