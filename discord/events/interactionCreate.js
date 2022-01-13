'use strict';

const config = require('config');

module.exports = async (context, interaction) => {
  const { buttonHandlers } = context;

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
