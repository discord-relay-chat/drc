'use strict';

const config = require('../../config');
const statsCmd = require('./stats');
const { MessageEmbed } = require('discord.js');
const { isHTTPRunning } = require('../common');
const { isHostRunning } = require('../../host');

async function systemInfo (context, ...a) {
  context.options = { returnCalcResults: true };
  const stats = await statsCmd(context, ...a);
  const embed = new MessageEmbed()
    .setColor(config.app.stats.embedColors.main)
    .setTitle('System Information');

  if (stats.errors > 0) {
    embed.addField('Bot ERRORS', `${stats.errors}`);
  }

  if (stats.irc.errors > 0) {
    embed.addField('IRC ERRORS', `${stats.irc.errors}`);
  }

  const ksMiss = Number(stats.redis.stats.keyspace_misses);
  const ksHit = Number(stats.redis.stats.keyspace_hits);
  const httpRunning = await isHTTPRunning(context.registerOneTimeHandler, context.removeOneTimeHandler);
  const hostRunning = await isHostRunning(context);

  embed
    .addFields(
      { name: 'Bot uptime', value: stats.lastCalcs.uptimeFormatted, inline: true },
      {
        name: 'IRC uptime',
        value: stats.irc.uptime + (stats.irc?.discordReconnects ? `\n(${stats.irc?.discordReconnects} bot reconnects)` : ''),
        inline: true
      },
      { name: 'System uptime', value: stats.lastCalcs.systemUptime, inline: true },
      { name: 'HTTP daemon?', value: httpRunning ? `Yes (as "${httpRunning.fqdn}")` : '_**No**_', inline: true },
      { name: 'Host daemon?', value: hostRunning ? 'Yes' : '_**No**_', inline: true }
    );

  embed.addFields(
    { name: 'Memory available', value: stats.lastCalcs.memoryAvailablePercent + '%', inline: true },
    { name: 'Load averages', value: stats.sinceLast.loadavg.join(', '), inline: true },
    { name: 'Log size', value: `${Number(stats.lastCalcs.logsSizeInMB).toLocaleString(undefined, { maximumFractionDigits: 2 })}MB`, inline: true },
    { name: 'Redis clients', value: stats.redis.clients.connected_clients.toString(), inline: true },
    {
      name: 'Redis memory (used/rss/peak)',
      value: `${stats.redis.memory.used_memory_human.toString()} / ` +
      `${stats.redis.memory.used_memory_rss_human.toString()} / ${stats.redis.memory.used_memory_peak_human.toString()}`,
      inline: true
    },
    { name: 'Redis CHR', value: Number(ksMiss / (ksMiss + ksHit)).toFixed(4).toString(), inline: true }
  );

  context.sendToBotChan(embed, true);
}

module.exports = systemInfo;
