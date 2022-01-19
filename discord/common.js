'use strict';

const fs = require('fs');
const path = require('path');
const config = require('config');
const Redis = require('ioredis');
const { nanoid } = require('nanoid');
const { PREFIX, matchNetwork } = require('../util');
const { MessageMentions: { CHANNELS_PATTERN } } = require('discord.js');

function dynRequireFrom (dir, addedCb) {
  return fs.readdirSync(dir).reduce((a, dirEnt) => {
    const fPath = path.join(dir, dirEnt);
    const fParsed = path.parse(fPath);

    if (!fs.statSync(fPath).isDirectory() && fParsed.ext === '.js' && fParsed.name !== 'index') {
      if (addedCb) {
        addedCb(fPath);
      }

      return {
        [fParsed.name]: require(fPath),
        ...a
      };
    }

    return a;
  }, {});
}

const discordEscapeRx = /([*_`])/g;
function simpleEscapeForDiscord (s) {
  let lastIndex = 0;
  let accum = '';

  for (const match of [...s.matchAll(discordEscapeRx)]) {
    console.debug(match, lastIndex, match.index, s.slice(lastIndex, match.index), s.slice(match.index, match.index + 1));
    accum += s.slice(lastIndex, match.index) + '\\' + s.slice(match.index, match.index);
    lastIndex = match.index;
  }

  if (!lastIndex) {
    accum = s;
  } else {
    accum += s.slice(lastIndex, s.length);
  }

  if (s !== accum) {
    console.debug(`escapeForDiscord "${s}" -> "${accum}"`);
  }

  return accum;
}

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
    return {
      title: `Add or remove strings to the \`${commandName}\` list.`,
      usage: 'network subcommand [string]',
      subcommands: {
        add: {
          text: `Adds \`string\` to the \`${commandName}\` list.`
        },
        remove: {
          text: `Removes \`string\` from the \`${commandName}\` list.`
        },
        clear: {
          text: `Removes all strings from the \`${commandName}\` list.`
        }
      }
    };
  };

  return f;
}

module.exports = {
  dynRequireFrom,
  simpleEscapeForDiscord,
  generateListManagementUCExport,

  senderNickFromMessage (msgObj) {
    const matchRx = new RegExp(`${config.app.render.message.normal.head}${String.raw`(?:\*\*)?(.*)(?:\*\*)`}${config.app.render.message.normal.foot}`, 'g');
    const replyNickMatch = msgObj.content?.matchAll(matchRx);

    if (replyNickMatch && !replyNickMatch.done) {
      const replyNickArr = replyNickMatch.next().value;

      if (replyNickArr && replyNickArr.length > 1) {
        return replyNickArr[1].replace(/\\/g, '');
      }
    }
  },

  messageIsFromAllowedSpeaker (data, { sendToBotChan = () => {} }) {
    if (!data.author || !config.app.allowedSpeakers.includes(data.author.id)) {
      if (data.author && data.author.id !== config.discord.botId) {
        sendToBotChan('`DISALLOWED SPEAKER` **' + data.author.username +
          '#' + data.author.discriminator + '**: ' + data.content);
        console.error('DISALLOWED SPEAKER', data.author, data.content);
      }

      return false;
    }

    return true;
  },

  async servePage (context, data, renderType, callback) {
    if (!context || !data || !renderType) {
      throw new Error('not enough args');
    }

    const name = nanoid();

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
    const name = nanoid();

    if (!data.length) {
      context.sendToBotChan(`No messages for \`${context.network}\` were found.`);
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
    const msgKey = ':' + [Number(msgObj.timestamp), nanoid()].join(':');
    const fullKey = key + msgKey;
    const msgId = await rClient.xadd(key, '*', 'message', msgKey);
    await rClient.set(fullKey, JSON.stringify({ __drcMsgId: msgId, ...msgObj }));
    rClient.disconnect();
    return { msgId, msgKey };
  },

  formatKVs (obj, delim = ':\t') {
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
    return Object.keys(obj).sort().map((k) => `\`${k.padStart(maxPropLen, ' ')}\`${delim}**${vFmt(obj[k])}**`).join('\n');
  },

  generatePerChanListManagementUCExport (commandName, additionalCommands) {
    return function (context, ...a) {
      const [netStub, channelIdSpec] = context.options._;
      const { network } = matchNetwork(netStub);

      if (!channelIdSpec.match(CHANNELS_PATTERN)) {
        throw new Error(`Bad channel ID spec ${channelIdSpec}`);
      }

      const [, channel] = [...channelIdSpec.matchAll(CHANNELS_PATTERN)][0];

      const key = [network, channel].join('_');
      const cmdFunctor = generateListManagementUCExport(`${commandName}_${key}`, additionalCommands);

      context.options._[1] = context.options._[0];
      a[1] = a[0];
      context.options._.shift();
      a.shift();
      return cmdFunctor(context, ...a);
    };
  },

  tickleExpiry: async (network, chanId) => {
    if (!network || !chanId) {
      console.error('tickleExpiry bad args', network, chanId);
      return null;
    }

    const rc = new Redis(config.redis.url);
    const aliveKey = `${PREFIX}:pmchan:aliveness:${chanId}:${network}`;
    await rc.set(aliveKey, chanId);
    await rc.expire(aliveKey, config.discord.privMsgChannelStalenessTimeMinutes * 60);
    rc.disconnect();
    console.log('tickleExpiry', chanId, network, aliveKey, 'expires',
      new Date(Number(new Date()) + (config.discord.privMsgChannelStalenessTimeMinutes * 60 * 1000)).toLocaleString());
  }
};
