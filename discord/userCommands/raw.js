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

module.exports = f;
