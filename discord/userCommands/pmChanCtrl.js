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
  const network = PrivmsgMappings.findNetworkForKey(context.toChanId);
  const [subCmd] = context.argObj._;

  if (!subCommands[subCmd]) {
    return `Bad subcommand "${subCmd}"`;
  }

  return subCommands[subCmd]?.(context, network);
}

module.exports = f;
