'use strict';

const { PrivmsgMappings, fmtDuration } = require('../../util');
const { aliveKey } = require('../common');

const subCommands = {
  aliveness: async (context, network) => {
    const key = aliveKey(network, context.toChanId);
    const ttl = await context.redis.ttl(aliveKey(network, context.toChanId));
    return {
      ttl,
      ttlHumanReadable: ttl === -1 ? 'Forever!' : fmtDuration(0, true, ttl * 1000),
      key
    };
  }
};

subCommands.ttl = subCommands.aliveness;

async function f (context) {
  const network = await PrivmsgMappings.findNetworkForKey(context.toChanId);
  const [subCmd] = context.argObj._;

  if (!subCommands[subCmd]) {
    return `Bad subcommand "${subCmd}"`;
  }

  return subCommands[subCmd]?.(context, network);
}

f.__drcHelp = () => {
  return {
    title: 'Query Private Message channel attributes',
    usage: '[subcommand]',
    notes: 'Must be run **in** the PM channel of interest. The only currently-available subcommand is `aliveness`, ' +
      'which will return the time-to-live information of the channel.'
  };
};

module.exports = f;
