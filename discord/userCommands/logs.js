'use strict';

const { getLogs, matchNetwork, resolveNameForIRC } = require('../../util');
const { serveMessages } = require('../common');
const { MessageMentions: { CHANNELS_PATTERN } } = require('discord.js');

module.exports = async function (context) {
  const [netStub, chanId] = context.argObj._;
  const { network } = matchNetwork(netStub);
  const chanMatch = [...chanId.matchAll(CHANNELS_PATTERN)];

  if (!chanMatch.length) {
    throw new Error('bad channel ' + chanId);
  }

  if (context.options.onlyNicks) {
    context.options.onlyNicks = context.options.onlyNicks.split(',');
  }

  const resChan = '#' + resolveNameForIRC(network, context.channelsById[chanMatch[0][1]].name);
  const retList = await getLogs(network, resChan, context.options.from, context.options.to, 'json', context.options.onlyNicks);
  serveMessages({ network, ...context }, retList.map((data) => ({ 
    timestamp: data.__drcIrcRxTs,
    data
  })));
};
