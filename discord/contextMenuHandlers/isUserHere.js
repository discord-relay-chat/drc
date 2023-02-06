'use strict';

const { MessageEmbed } = require('discord.js');
const userCommands = require('../userCommands');
const { createArgObjOnContext, simpleEscapeForDiscord, contextMenuCommonHandlerDefered } = require('../common');

module.exports = {
  commandName: 'Is user here?',
  handler: async function (context, ...a) {
    return contextMenuCommonHandlerDefered(async ({ message, senderNick }) => {
      const data = { message };
      context.discordMessage = message;
      context.isFromReaction = true;
      const result = await userCommands('isUserHere')(context, ...createArgObjOnContext(context, data, null, true));
      return new MessageEmbed()
        .setTitle(`Is **${simpleEscapeForDiscord(senderNick)}** here?`)
        .setDescription(result)
        .setTimestamp();
    }, context, ...a);
  }
};
