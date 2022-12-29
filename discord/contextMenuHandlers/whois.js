'use strict';

const { MessageEmbed } = require('discord.js');
const userCommands = require('../userCommands');
const { contextMenuCommonHandler } = require('../common');

module.exports = {
  commandName: "Whois this user?",
  handler: async function (context, ...a) {
    return contextMenuCommonHandler(async ({ message, senderNick }) => {
      const parent = context.channelsById[context.channelsById[message?.channelId]?.parent]?.name;
      const args = [parent, senderNick, message?.channelId];
      context.argObj = { _: args };
      console.log('/whois context menu', senderNick, args);
      await userCommands('whois')(context, ...args);
      return new MessageEmbed()
        .setTitle(`Sending \`/whois ${senderNick}\`...`)
        .setTimestamp();
    }, context, ...a);
  }
};
