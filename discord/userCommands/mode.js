'use strict';

const { matchNetwork } = require('../../util');
const { convertDiscordChannelsToIRCInString } = require('../common');

async function f (context) {
  if (context.argObj._.length < 1) {
    throw new Error('not enough args');
  }

  const { network } = matchNetwork(context.argObj._[0]);
  let [, nickOrChan] = context.argObj._;
  nickOrChan = convertDiscordChannelsToIRCInString(nickOrChan, context, network);

  let retStr;
  if (context.argObj._.length < 3) {
    console.log((retStr = `Requesting mode for nickOrChan "${nickOrChan}"...`));
    return context.publish({
      type: 'irc:mode:get',
      data: {
        __drcNetwork: network,
        network,
        nickOrChan
      }
    });
  }

  let [,, mode] = context.argObj._;
  mode = mode.replaceAll(/["\\]+/g, '');
  console.log((retStr = `Setting mode "${mode}" for nickOrChan "${nickOrChan}"...`));
  await context.publish({
    type: 'irc:mode:set',
    data: {
      __drcNetwork: network,
      network,
      nickOrChan,
      mode
    }
  });

  return retStr;
}

f.__drcHelp = () => {
  return {
    title: 'Query or modify user or channel modes',
    usage: 'network channelOrNick [mode]',
    notes: 'When setting a mode, the `mode` argument must be quoted when removing a mode, e.g. `!mode libera #testchannel "-s"`.'
  };
};

module.exports = f;
