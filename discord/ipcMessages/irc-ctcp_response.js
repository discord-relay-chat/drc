'use strict';

const config = require('config');
const { MessageEmbed } = require('discord.js');

module.exports = async function (parsed, context) {
  const { type, target, nick, ident, hostname, message } = parsed.data;

  if (nick !== config.irc.registered[parsed.data.__drcNetwork].user.nick) {
    context.sendToBotChan(new MessageEmbed()
      .setColor('#11bbbb')
      .setTitle(`CTCP \`${type.toUpperCase()}\` response on \`${parsed.data.__drcNetwork}\``)
      .setDescription(`From **${nick}** <_${ident}@${hostname}_>`)
      .addFields(
        { name: 'Target', value: target, inline: true },
        { name: 'Message', value: message, inline: true }
      )
      .setTimestamp(),
    true);
  }
};
