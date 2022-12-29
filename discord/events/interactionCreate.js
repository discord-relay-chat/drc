'use strict';

const config = require('config');
const { ApplicationCommandType } = require('discord-api-types/v9');
const ContextMenuHandlers = require('../contextMenuHandlers');
const { MessageEmbed } = require('discord.js');

module.exports = async (context, interaction) => {
  const { buttonHandlers } = context;

  if (interaction.isContextMenu() && interaction.targetType === 'MESSAGE') {
    const handlers = Object.values(ContextMenuHandlers).filter(({ commandName }) => commandName === interaction.commandName);
    if (handlers.length !== 1) {
      console.error(`Bad number of handlers for context menu "${interaction.commandName}": ${handlers.length}`);
      if (handlers.length === 0) {
        return;
      }
    }

    const [{ handler }] = handlers;
    if (!handler) {
      console.error(`interactionCreate event of type ${ApplicationCommandType.Message} but no handler specified for commandName "${interaction.commandName}"!`);
      interaction.update({
        components: [],
        embeds: [
          new MessageEmbed().setTitle(`no handler specified for commandName "${interaction.commandName}"`).setTimestamp()
        ]
      }).catch(console.error);
      return;
    }

    return handler(context, interaction);
  }

  if (!interaction.isButton()) {
    return;
  }

  console.debug('interactionCreate', interaction);

  if (!config.app.allowedSpeakers.includes(interaction.user.id)) {
    console.warn('BAD BUTTON PUSH', interaction.user);
    return;
  }

  const handlerList = buttonHandlers[interaction.customId];

  if (!handlerList) {
    console.error(`No handlers registered for button ${interaction.customId}!`);
    return;
  }

  try {
    handlerList.forEach((handler) => handler(interaction));
  } catch (err) {
    console.error('Button handler failed:', err.message, err.stack);
  }

  buttonHandlers[interaction.customId] = [];
};
