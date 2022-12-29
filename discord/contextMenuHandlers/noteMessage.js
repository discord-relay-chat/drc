'use strict';

const { MessageEmbed } = require('discord.js');
const { contextMenuCommonHandlerNonEphemeral } = require('../common');
const { makeNoteOfMessage } = require('../interactionsCommon');

module.exports = {
  commandName: 'Note this message',
  handler: async function (context, ...a) {
    return contextMenuCommonHandlerNonEphemeral(async ({ message, senderNick }) => {
      const parent = context.channelsById[context.channelsById[message?.channelId]?.parent]?.name;
      const res = await makeNoteOfMessage(context, { message });
      console.log('makeNoteOfMessage ->', res);
      return new MessageEmbed()
        .setTitle(`Note for **${senderNick}** added:`)
        .setDescription(res +
          `\n\nRun \`!notes ${parent} ${senderNick}\` to query all notes for this user.`)
        .setTimestamp();
    }, context, ...a);
  }
};
