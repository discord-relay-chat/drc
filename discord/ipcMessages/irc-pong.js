'use strict';

const { MessageEmbed } = require('discord.js');

module.exports = async function (parsed, context) {
  const { sendToBotChan, stats } = context;
  const [, startTs] = parsed.data.message.split('-');
  const latencyToDiscord = new Date() - startTs;
  const embed = new MessageEmbed()
    .setColor('#22aaaa')
    .setTitle(`Latencies to \`${parsed.data.__drcNetwork}\``)
    .addFields(
      { name: 'To server', value: `${parsed.data.latencyToIRC}ms`, inline: true },
      { name: 'To us', value: `${latencyToDiscord}ms`, inline: true }
    )
    .addField('To all servers', '(in milliseconds)')
    .addFields(...stats.lastCalcs.lagAsEmbedFields)
    .setTimestamp();

  sendToBotChan(embed, true);
};
