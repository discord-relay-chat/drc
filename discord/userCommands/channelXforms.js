'use strict';

const config = require('config');
const { matchNetwork, ChannelXforms, expiryDurationFromOptions } = require('../../util');
const { formatKVs, servePage, convertDiscordChannelsToIRCInString } = require('../common');
const { nanoid } = require('nanoid');

async function formattedGet (network) {
  return `\nChannel transforms for **${network}** (\`Discord\` → IRC):\n` +
    formatKVs(Object.fromEntries(Object.entries(
      ChannelXforms.forNetwork(network)).map(([k, v]) => [k, `#${v}`])), ' → ');
}

const serveCache = {};

const subCommands = {
  get: async (context, network) => formattedGet(network),

  set: async (context, network, dChan, iChan) => {
    iChan = convertDiscordChannelsToIRCInString(iChan, context);
    await ChannelXforms.set(network, dChan, iChan.replace(/\\/g, ''));
    return formattedGet(network);
  },

  remove: async (context, network, dChan) => {
    await ChannelXforms.remove(network, dChan);
    return formattedGet(network);
  },

  serve: async (context, network) => {
    const transforms = Object.entries(ChannelXforms.forNetwork(network))
      .map(([discord, irc]) => ({ discord, irc, id: nanoid() }));

    const serveId = await servePage(context, {
      transforms,
      network
    }, 'channelXforms');

    const register = () => context.registerOneTimeHandler(
      'discord:channelXform:httpReq:' + serveId, serveId, xformRequestHandler);

    const xformRequestHandler = async (...a) => {
      console.log('xformRequestHandler!', ...a);
      if (serveCache[serveId]) {
        register();
      }
    };

    serveCache[serveId] = setTimeout(() => delete serveCache[serveId], expiryDurationFromOptions(context.options));

    register();

    return `${config.http.proto ?? 'https'}://${config.http.fqdn}/${serveId}`;
  }
};

module.exports = async function (context) {
  const [netStub, subCmd] = context.argObj._;

  if (netStub === 'reload') {
    ChannelXforms._load();
    return ChannelXforms.cache;
  }

  const { network } = matchNetwork(netStub);
  return subCommands[subCommands[subCmd] ? subCmd : 'get'](context, network, ...context.argObj._.slice(2));
};
