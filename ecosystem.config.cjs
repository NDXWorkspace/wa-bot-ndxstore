module.exports = {
  apps: [{
    name: 'wa-bot-ndxstore',
    script: './index.js',
    node_args: '--no-warnings',
    watch: false,
    max_memory_restart: '500M',
    restart_delay: 5000,
    max_restarts: 10,
    min_uptime: 10000,
    kill_timeout: 30000,
    wait_ready: false,
    listen_timeout: 30000,
    exp_backoff_restart_delay: 5000,
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    error_file: './logs/error.log',
    out_file: './logs/output.log',
    combine_logs: true,
    env: {
      NODE_ENV: 'production',
    },
  }],
};
