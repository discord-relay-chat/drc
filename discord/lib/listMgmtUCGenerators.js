'use strict';

const { PREFIX, matchNetwork, scopedRedisClient } = require('../../util');
const { MessageMentions: { CHANNELS_PATTERN } } = require('discord.js');
const {
  convertDiscordChannelsToIRCInString,
  simpleEscapeForDiscord
} = require('./strings');

function attachHelp (cmdFunc, commandName, additionalCommands, { overrideHelpFields = {} } = {}) {
  const addlCommandsHelp = Object.entries(additionalCommands ?? {})
    .filter(([k]) => k.indexOf('_') !== 0)
    .reduce((a, [k, v]) => ({
      [k]: {
        text: k
      },
      ...a
    }), {});

  const defaultHelp = {
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

  cmdFunc.__drcHelp = () => {
    return {
      ...defaultHelp,
      ...overrideHelpFields
    };
  };
}

// keySubstitue only applies (if set) to additionalCommands!
function generateListManagementUCExport (commandName,
  additionalCommands,
  disallowClear = false,
  keySubstitute = null,
  callOnChange = null,
  overrideHelpFields = {}
) {
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

    const addRmArgs = async () => [key, await argStr()];

    let onChangeWrapper = async (a) => a;
    if (callOnChange) {
      onChangeWrapper = async (changed) => {
        if (changed) {
          await callOnChange(context, ...await addRmArgs());
        }
      };
    }

    return scopedRedisClient(async (redis) => {
      switch (cmd) {
        case 'add':
          await onChangeWrapper(await redis.sadd(...await addRmArgs()));
          break;
        case 'clear':
          // this really should be a button for confirmation instead of hardcoded!
          if (!disallowClear) {
            await redis.del(key);
          }
          break;
        case 'remove':
          await onChangeWrapper(await redis.srem(...await addRmArgs()));
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

  attachHelp(f, commandName, additionalCommands, { overrideHelpFields });
  return f;
}

function generateListManagementUCExportOpts (commandName, {
  additionalCommands,
  disallowClear = false,
  keySubstitute = null,
  callOnChange = null,
  overrideHelpFields = {}
} = {}) {
  return generateListManagementUCExport(commandName, additionalCommands, disallowClear, keySubstitute, callOnChange, overrideHelpFields);
}

function generatePerChanListManagementUCExport (commandName, additionalCommands, enforceChannelSpec = true, options = {}) {
  const cmdFunc = function (context, ...a) {
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

    const cmdFunctor = generateListManagementUCExportOpts(`${commandName}_${key}`, {
      ...options,
      additionalCommands
    });

    context.options._[1] = context.options._[0];
    a[1] = a[0];
    context.options._.shift();
    a.shift();
    return cmdFunctor(context, ...a);
  };

  attachHelp(cmdFunc, commandName, additionalCommands, options);
  return cmdFunc;
}

module.exports = {
  generateListManagementUCExport,
  generateListManagementUCExportOpts,
  generatePerChanListManagementUCExport
};
