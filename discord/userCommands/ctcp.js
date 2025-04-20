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

f.__drcHelp = () => ({
  title: 'Send CTCP messages to IRC users',
  usage: 'network nick type [params...]',
  notes: 'Sends Client-To-Client Protocol (CTCP) messages to specified IRC users. Common types include VERSION, TIME, PING, and CLIENTINFO.'
});

module.exports = f;
