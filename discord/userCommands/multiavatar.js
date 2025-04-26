'use strict';

const { MessageEmbed } = require('discord.js');
const { getApiKey, rotateApiKey } = require('../../lib/multiavatar');

const Commands = {
  async rotate (context) {
    const newKey = await rotateApiKey();

    const embed = new MessageEmbed()
      .setColor('GREEN')
      .setTitle('Multiavatar API Key Rotated')
      .setDescription(`New key: \`${newKey}\``);

    await context.sendToBotChan({ embeds: [embed] }, true);
  }
};

async function multiavatar (context) {
  const [command] = context.options._;

  if (!command) {
    const currentKey = await getApiKey();
    if (!currentKey) {
      return 'No API key is set. Create one with: multiavatar rotate';
    }
    return `Current API key: \`${currentKey}\`. Use 'multiavatar rotate' to generate a new one.`;
  }

  if (!Commands[command]) {
    return `Unknown subcommand "${command}". Available: ${Object.keys(Commands).join(', ')}.`;
  }

  return Commands[command](context);
}

multiavatar.__drcHelp = () => 'Manage multiavatar API key: rotate';

module.exports = multiavatar;
