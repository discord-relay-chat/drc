'use strict';

const { MessageEmbed } = require('discord.js');
const { contextMenuCommonHandlerNonEphemeral } = require('../common');
const notesCommand = require('../userCommands/notes');

module.exports = {
  commandName: "Query user's notes",
  handler: async function (context, ...a) {
    return contextMenuCommonHandlerNonEphemeral(async ({ message, senderNick }) => {
      const parent = context.channelsById[context.channelsById[message?.channelId]?.parent]?.name;
      const cmdArgs = [parent, senderNick];
      context.options = context.argObj = { _: cmdArgs };
      const embed = new MessageEmbed()
        .setTitle(`Notes for **${senderNick}**:`)
        .setTimestamp();
      embed.addFields((await notesCommand(context, ...cmdArgs)).map((note, index) => {
        if (typeof (note) === 'string') {
          return { name: `Note ${index + 1}`, value: note, inline: false };
        }
        return null;
      })
        .filter(x => !!x));
      return embed;
    }, context, ...a);
  }
};
