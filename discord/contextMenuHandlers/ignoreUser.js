'use strict';

const { MessageEmbed } = require('discord.js');
const ignoreCommand = require('../userCommands/ignore');
const { contextMenuCommonHandler } = require('../common');

module.exports = {
  commandName: 'Ignore user',
  handler: async function (context, ...a) {
    return contextMenuCommonHandler(async ({ message, senderNick }) => {
      const parent = context.channelsById[context.channelsById[message?.channelId]?.parent]?.name;
      const cmdArgs = [parent, 'add', senderNick];
      context.options = context.argObj = { _: cmdArgs };
      const res = await ignoreCommand(context, ...cmdArgs);
      let title = `Failed to ignore **${senderNick}**`;
      if (res.includes(senderNick)) {
        title = `Ignored **${senderNick}**`;
      }
      return new MessageEmbed().setTitle(title).setTimestamp();
    }, context, ...a);
  }
};
