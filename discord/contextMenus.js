'use strict';

const config = require('../config');
const { ContextMenuCommandBuilder } = require('@discordjs/builders');
const { REST } = require('@discordjs/rest');
const { Routes, ApplicationCommandType } = require('discord-api-types/v9');
const ContextMenuHandlers = require('./contextMenuHandlers');

require('../logger')('discord/contextMenus');

const COMMANDS = Object.entries(ContextMenuHandlers)
  .map(([, { commandName }]) =>
    new ContextMenuCommandBuilder()
      .setName(commandName)
      .setType(ApplicationCommandType.Message))
  .map(command => command.toJSON());

module.exports = function () {
  (new REST({ version: '9' }).setToken(config.discord.token))
    .put(Routes.applicationGuildCommands(config.discord.botId, config.discord.guildId), { body: COMMANDS })
    .then(() => console.log(`Successfully registered ${COMMANDS.length} context menus: "` +
      `${Object.entries(ContextMenuHandlers).map(([, { commandName }]) => commandName).join('", ')}"`))
    .catch(console.error);
};
