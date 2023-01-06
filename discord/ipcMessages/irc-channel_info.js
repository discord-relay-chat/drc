'use strict';

const { MessageEmbed } = require('discord.js');

module.exports = async function (parsed, context) {
  const network = parsed.data.__drcNetwork;
  delete parsed.data.__drcNetwork;
  delete parsed.data._orig;
  const { channel } = parsed.data;
  delete parsed.data.channel;

  try {
    parsed.data.tags = JSON.parse(parsed.data.tags);
  } catch {
    delete parsed.data.tags;
  }

  const embed = new MessageEmbed()
    .setColor('#11bbbb')
    .setTitle(`Channel info for **${channel}** on \`${network}\``)
    .setTimestamp();

  Object.keys(parsed.data).forEach((key) => {
    const valStr = JSON.stringify(parsed.data[key]);
    if (valStr.length) embed.addField(key[0].toUpperCase() + key.slice(1), valStr);
  });

  context.sendToBotChan(embed, true);
};
