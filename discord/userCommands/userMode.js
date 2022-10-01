'use strict';

const { matchNetwork } = require('../../util');

async function f (context) {
  if (context.argObj._.length < 1) {
    throw new Error('not enough args');
  }

  const { network } = matchNetwork(context.argObj._[0]);
  console.log('\n\n', context.argObj._, '\n\n');

  if (context.argObj._.length < 2) {
    return context.publish({
      type: 'irc:userMode:get',
      data: {
        __drcNetwork: network,
        network
      }
    });
  }

  await context.publish({
    type: 'irc:userMode:set',
    data: {
      __drcNetwork: network,
      network,
      mode: context.argObj._[1]
    }
  });
}

f.__drcHelp = () => {
  return '!userMode network [mode]';
};

module.exports = f;
