'use strict';

const { getNetworkAndChanNameFromUCContext, convertDiscordChannelsToIRCInString } = require('../common');
const { PREFIX, scopedRedisClient } = require('../../util');

async function f (context, ...a) {
  const { network } = getNetworkAndChanNameFromUCContext(context);
  if (!network) {
    return `Unable to determine network ("${network}")`;
  }

  let [, ...rawList] = a;
  rawList = await Promise.all(rawList.map(async (r) => convertDiscordChannelsToIRCInString(r, context, network)));
  console.log('Sending raw', network, rawList);

  await scopedRedisClient(async (r) => r.publish(PREFIX, JSON.stringify({
    type: 'irc:raw',
    data: {
      network: { name: network },
      rawList
    }
  })));
}

f.__drcHelp = () => ({
  title: 'Send raw IRC commands to the server',
  usage: 'network raw_command [additional_commands...]',
  notes: 'Sends raw IRC protocol commands directly to the specified network. Use with caution as this bypasses normal command processing.'
});

module.exports = f;
