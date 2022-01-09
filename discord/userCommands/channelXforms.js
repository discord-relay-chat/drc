'use strict';

const { matchNetwork, ChannelXforms } = require('../../util');
const { formatKVs } = require('../common');
const { MessageMentions: { CHANNELS_PATTERN } } = require('discord.js');

async function formattedGet (network) {
  return `\nChannel transforms for **${network}** (\`Discord\` → IRC):\n` +
    formatKVs(Object.fromEntries(Object.entries(
      ChannelXforms.forNetwork(network)).map(([k, v]) => [k, `#${v}`])), ' → ');
}

const subCommands = {
  get: async (context, network) => formattedGet(network),

  set: async (context, network, dChan, iChan) => {
    if (iChan.match(CHANNELS_PATTERN)) {
      const [chanMatch, channelId] = [...iChan.matchAll(CHANNELS_PATTERN)][0];
      iChan = iChan.replace(chanMatch, '#' + context.getDiscordChannelById(channelId).name);
    }

    await ChannelXforms.set(network, dChan, iChan.replace(/\\/g, ''));
    return formattedGet(network);
  },

  remove: async (context, network, dChan) => {
    await ChannelXforms.remove(network, dChan);
    return formattedGet(network);
  }
};

module.exports = async function (context) {
  const [netStub, subCmd] = context.argObj._;

  if (netStub === 'reload') {
    ChannelXforms._load();
    return ChannelXforms.cache;
  }

  const { network } = matchNetwork(netStub);
  return subCommands[subCmd ?? 'get'](context, network, ...context.argObj._.slice(2));
};
