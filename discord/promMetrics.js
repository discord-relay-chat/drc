'use strict';

const { Counter, Gauge, Histogram } = require('../lib/promRedisExport')('discord');

const msgRxCounter = new Counter({
  name: 'drc_discord_message_received',
  help: 'Any Discord message type received'
});

const userScriptsQHWMGauge = new Gauge({
  name: 'drc_discord_user_script_queue_high_watermark',
  help: 'High watermark of the user script run queue'
});

const userScriptRuntimeHistogram = new Histogram({
  name: 'drc_discord_user_script_runtime',
  help: 'The runtime of user scripts',
  unit: 'milliseconds',
  labelNames: ['scriptName']
});

const systemInfoLogSizeGauge = new Gauge({
  name: 'drc_discord_system_info_log_size',
  help: 'Total log size on disk, in megabytes',
  units: 'megabytes'
});

const userCommandUsageCounter = new Counter({
  name: 'drc_discord_user_command_usage_counter',
  help: 'Usage counter of user commands',
  labelNames: ['commandName']
});

module.exports = {
  msgRxCounter,
  userScriptsQHWMGauge,
  userScriptRuntimeHistogram,
  systemInfoLogSizeGauge,
  userCommandUsageCounter
};
