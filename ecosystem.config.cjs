module.exports = {
  apps: [{
    name: 'wa-bot-ndxstore',
    script: './index.js',
    node_args: '--no-warnings',
    watch: false,
    max_memory_restart: '200M',
    restart_delay: 5000,
    max_restarts: 10,
    env: {
      NODE_ENV: 'production',
    },
  }],
};
