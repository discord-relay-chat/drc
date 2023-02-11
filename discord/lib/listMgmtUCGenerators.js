'use strict';

const { PREFIX, matchNetwork, scopedRedisClient } = require('../../util');
const { MessageMentions: { CHANNELS_PATTERN } } = require('discord.js');
const {
  convertDiscordChannelsToIRCInString,
  simpleEscapeForDiscord
} = require('./strings');

// keySubstitue only applies (if set) to additionalCommands!
function generateListManagementUCExport (commandName, additionalCommands, disallowClear = false, keySubstitute = null) {
  const f = async function (context, ...a) {
    const [netStub, cmd] = a;

    if (!netStub) {
      return `Not enough arguments! Usage: \`${commandName} [networkStub] [command] (args...)\``;
    }

    let network;
    try {
      network = matchNetwork(netStub).network;
    } catch (NetworkNotMatchedError) {
      if (additionalCommands[netStub]) {
        return additionalCommands[netStub](context, ...a);
      }
    }

    const key = [PREFIX, commandName, network].join(':');

    const argStr = async () => {
      if (a.length < 3) {
        throw new Error(`Not enough args for ${cmd}!`);
      }

      return convertDiscordChannelsToIRCInString(a.slice(2).join(' '), context);
    };

    return scopedRedisClient(async (redis) => {
      switch (cmd) {
        case 'add':
          await redis.sadd(key, await argStr());
          break;
        case 'clear':
          // this really should be a button for confirmation instead of hardcoded!
          if (!disallowClear) {
            await redis.del(key);
          }
          break;
        case 'remove':
          await redis.srem(key, await argStr());
          break;
      }

      if (additionalCommands && additionalCommands[cmd]) {
        const originalKey = key;
        const addlKey = [PREFIX, keySubstitute ?? commandName, network].join(':');
        return additionalCommands[cmd]({ key: addlKey, originalKey, network, redis, ...context }, ...a);
      }

      const retList = (await redis.smembers(key)).sort();
      const fmtName = commandName[0].toUpperCase() + commandName.slice(1);
      retList.__drcFormatter = () => retList.length
        ? `${fmtName} ` +
        `list for \`${network}\` (${retList.length}):\n\n   ⦁ ${retList.map(simpleEscapeForDiscord).join('\n   ⦁ ')}\n`
        : `${fmtName} list for \`${network}\` has no items.`;

      return retList;
    });
  };

  const addlCommandsHelp = Object.entries(additionalCommands ?? {})
    .filter(([k]) => k.indexOf('_') !== 0)
    .reduce((a, [k, v]) => ({
      [k]: {
        text: k
      },
      ...a
    }), {});

  f.__drcHelp = () => {
    return {
      title: `Add or remove strings to the \`${commandName}\` list.`,
      usage: 'network subcommand [string]',
      subcommands: {
        add: {
          header: 'Notes',
          text: `Adds \`string\` to the \`${commandName}\` list.`
        },
        remove: {
          header: 'Notes',
          text: `Removes \`string\` from the \`${commandName}\` list.`
        },
        clear: {
          header: 'Notes',
          text: `Removes all strings from the \`${commandName}\` list.`
        },
        ...addlCommandsHelp
      }
    };
  };

  return f;
}

function generatePerChanListManagementUCExport (commandName, additionalCommands, enforceChannelSpec = true) {
  return function (context, ...a) {
    const [netStub, channelIdSpec] = context.options._;
    const { network } = matchNetwork(netStub);
    let channel = channelIdSpec;

    if (enforceChannelSpec) {
      if (!channelIdSpec.match(CHANNELS_PATTERN)) {
        throw new Error(`Bad channel ID spec ${channelIdSpec}`);
      }

      [, channel] = [...channelIdSpec.matchAll(CHANNELS_PATTERN)][0];
    }

    const key = [network, channel].join('_');
    const addlCmd = additionalCommands?.[context.options._[context.options._.length - 1]];
    if (addlCmd) {
      return addlCmd({ key, network, ...context }, ...a);
    }

    const cmdFunctor = generateListManagementUCExport(`${commandName}_${key}`, additionalCommands);

    context.options._[1] = context.options._[0];
    a[1] = a[0];
    context.options._.shift();
    a.shift();
    return cmdFunctor(context, ...a);
  };
}

module.exports = {
  generateListManagementUCExport,
  generatePerChanListManagementUCExport
};
