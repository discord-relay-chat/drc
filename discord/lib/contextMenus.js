'use strict';

const { MessageEmbed } = require('discord.js');
const senderNickFromMessage = require('./senderNickFromMessage');

function contextMenuHandlerCommonInitial (context, ...a) {
  const [interaction] = a;
  const message = interaction?.options.get('message')?.message;
  const senderNick = senderNickFromMessage(message);
  return { interaction, message, senderNick };
}

async function _contextMenuCommonHandler (ephemeral, defer, innerHandler, context, ...a) {
  const { interaction, message, senderNick } = contextMenuHandlerCommonInitial(context, ...a);
  let replyEmbed = new MessageEmbed()
    .setTitle('Unable to determine IRC nickname from that message. Sorry!')
    .setTimestamp();

  if (defer) {
    await interaction.deferReply({ ephemeral });
  }

  if (message && senderNick) {
    replyEmbed = await innerHandler({ interaction, message, senderNick });
  }

  return (defer ? interaction.editReply : interaction.reply).bind(interaction)({
    embeds: [replyEmbed],
    ephemeral
  });
}

async function contextMenuCommonHandlerNonEphemeral (innerHandler, context, ...a) {
  return _contextMenuCommonHandler(false, false, innerHandler, context, ...a);
}

async function contextMenuCommonHandler (innerHandler, context, ...a) {
  return _contextMenuCommonHandler(true, false, innerHandler, context, ...a);
}

async function contextMenuCommonHandlerDefered (innerHandler, context, ...a) {
  return _contextMenuCommonHandler(true, true, innerHandler, context, ...a);
}

module.exports = {
  contextMenuCommonHandler,
  contextMenuCommonHandlerNonEphemeral,
  contextMenuCommonHandlerDefered
};
