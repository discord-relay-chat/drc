'use strict';

const { matchNetwork } = require('../../util');

async function f (context, ...a) {
  const [netStub, nick, type, ...params] = a;
  const { network } = matchNetwork(netStub);

  await context.publish({
    type: 'discord:requestCtcp:irc',
    data: {
      network,
      nick,
      type,
      params
    }
  });
}

module.exports = f;
