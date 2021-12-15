'use strict';

const uuid = require('uuid');
const config = require('config');
const Redis = require('ioredis');
const { PREFIX, matchNetwork } = require('../util');
const { MessageMentions: { CHANNELS_PATTERN } } = require('discord.js');

function generateListManagementUCExport (commandName, additionalCommands) {
  const f = async function (context, ...a) {
    const [netStub, cmd] = a;

    if (!netStub) {
      return `Not enough arguments! Usage: \`${commandName} [networkStub] [command] (args...)\``;
    }

    const { network } = matchNetwork(netStub);
    const key = [PREFIX, commandName, network].join(':');

    const argStr = () => {
      if (a.length < 3) {
        throw new Error(`Not enough args for ${cmd}!`);
      }

      return a.slice(2).join(' ');
    };

    switch (cmd) {
      case 'add':
        await context.redis.sadd(key, argStr());
        break;
      case 'clear':
        await context.redis.del(key);
        break;
      case 'remove':
        await context.redis.srem(key, argStr());
        break;
    }

    if (additionalCommands && additionalCommands[cmd]) {
      return additionalCommands[cmd]({ key, network, ...context }, ...a);
    }

    const retList = (await context.redis.smembers(key)).sort();
    const fmtName = commandName[0].toUpperCase() + commandName.slice(1);
    retList.__drcFormatter = () => retList.length
      ? `${fmtName} ` +
      `list for \`${network}\` (${retList.length}): **${retList.join('**, **')}**`
      : `${fmtName} list for \`${network}\` has no items.`;

    return retList;
  };

  f.__drcHelp = () => {
    return `!${commandName} network subcommand ...\n\n` +
    'Where \'subcommand\' is one of: add, remove, clear.\n' +
    '\'add\' & \'remove\' use the remaining arguments as the value; \'clear\' takes no arguments.\n\n' +
    (additionalCommands
      ? 'Additional subcommand:\n' +
      Object.keys(additionalCommands).filter(x => x[0] !== '_').join(', ')
      : '');
  };

  return f;
}

module.exports = {
  async servePage (context, data, renderType, callback) {
    if (!context || !data || !renderType) {
      throw new Error('not enough args');
    }

    const name = uuid.v4();

    context.registerOneTimeHandler('http:get-req:' + name, name, async () => {
      const r = new Redis(config.redis.url);
      await r.publish(PREFIX, JSON.stringify({
        type: 'http:get-res:' + name,
        data
      }));
      r.disconnect();

      if (callback) {
        callback(context);
      }
    });

    const options = Object.assign({}, context.options);
    delete options._;

    await context.publish({
      type: 'discord:createGetEndpoint',
      data: {
        name,
        renderType,
        options
      }
    });

    return name;
  },

  // this and ^servePage should be refactored together, they're very similar
  async serveMessages (context, data, callback) {
    const name = uuid.v4();

    if (!data.length) {
      context.sendToBotChan(`No messages for \`${context.network}\` have been squelched.`);
      return;
    }

    context.registerOneTimeHandler('http:get-req:' + name, name, async () => {
      const r = new Redis(config.redis.url);
      await r.publish(PREFIX, JSON.stringify({
        type: 'http:get-res:' + name,
        data: {
          network: context.network,
          elements: data
        }
      }));
      r.disconnect();

      if (callback) {
        callback(context);
      }
    });

    const options = Object.assign({}, context.options);
    delete options._;

    await context.publish({
      type: 'discord:createGetEndpoint',
      data: {
        name,
        renderType: 'digest',
        options
      }
    });

    const ttlSecs = options.ttl ? options.ttl * 60 : config.http.ttlSecs;
    context.sendToBotChan(`Digest of **${data.length}** messages for \`${context.network}\` ` +
      `(link expires in ${ttlSecs / 60} minutes): https://${config.http.fqdn}/${name}`);
  },

  async persistMessage (key, messageType, network, msgObj) {
    if (!config.user.persistMentions) {
      return;
    }

    if (!msgObj.timestamp) {
      console.warn('Can\'t persist without timestamp!', msgObj);
      return;
    }

    const rClient = new Redis(config.redis.url);
    key = [key, messageType, network, 'stream'].join(':');
    const msgKey = ':' + [Number(msgObj.timestamp), uuid.v4()].join(':');
    const fullKey = key + msgKey;
    const msgId = await rClient.xadd(key, '*', 'message', msgKey);
    await rClient.set(fullKey, JSON.stringify({ __drcMsgId: msgId, ...msgObj }));
    rClient.disconnect();
    return { msgId, msgKey };
  },

  formatKVs (obj) {
    const vFmt = (v) => {
      switch (typeof v) {
        case 'object':
          return '...';

        case 'boolean':
          return v ? ':white_check_mark:' : ':x:';

        default:
          return v;
      }
    };

    const maxPropLen = Object.keys(obj).reduce((a, k) => a > k.length ? a : k.length, 0) + 1;
    return Object.keys(obj).sort().map((k) => `\`${k.padStart(maxPropLen, ' ')}\`:\t**${vFmt(obj[k])}**`).join('\n');
  },

  generateListManagementUCExport,

  generatePerChanListManagementUCExport (commandName, additionalCommands) {
    return function (context, ...a) {
      const [netStub, channelIdSpec] = context.options._;
      const { network } = matchNetwork(netStub);

      if (!channelIdSpec.match(CHANNELS_PATTERN)) {
        throw new Error(`Bad channel ID spec ${channelIdSpec}`);
      }

      const [_, channel] = [...channelIdSpec.matchAll(CHANNELS_PATTERN)][0]; // eslint-disable-line no-unused-vars

      const key = [network, channel].join('_');
      const cmdFunctor = generateListManagementUCExport(`${commandName}_${key}`, additionalCommands);

      context.options._[1] = context.options._[0];
      a[1] = a[0];
      context.options._.shift();
      a.shift();
      return cmdFunctor(context, ...a);
    };
  }
};
