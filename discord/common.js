'use strict';

const fs = require('fs');
const path = require('path');
const config = require('config');
const { nanoid } = require('nanoid');
const { PREFIX, matchNetwork, fmtDuration, scopedRedisClient } = require('../util');
const { MessageMentions: { CHANNELS_PATTERN } } = require('discord.js');

const senderNickFromMessage = require('./lib/senderNickFromMessage');
const { serveMessages } = require('./lib/serveMessages');
const { isHTTPRunning } = require('../lib/isXRunning');
const { attachSentimentToMessages, averageSentiments, transformAveragesForDigestHTTP, roundSentimentScoreOnMessages } = require('../lib/sentiments');

function createArgObjOnContext (context, data, subaction, noNetworkFirstArg = false) {
  const tmplArr = [senderNickFromMessage(data?.message)];
  if (!noNetworkFirstArg) {
    tmplArr.unshift(context.channelsById[context.channelsById[data?.message.channelId].parent]?.name);
  }

  if (subaction) {
    if (subaction === 'whois') {
      tmplArr.push(data?.message.channelId); // discord channel ID for response
    } else {
      tmplArr.splice(1, 0, subaction);
    }
  }

  context.argObj = { _: tmplArr };
  console.debug('createArgObjOnContext', context.argObj);
  return tmplArr;
}

async function clearSquelched (context, ...a) {
  return context.redis.del([context.key, 'squelch'].join(':'));
}

async function digest (context, ...a) {
  const data = (await context.redis.lrange([context.key, 'squelch'].join(':'), 0, -1)).map(JSON.parse).reverse();

  const sentiments = await attachSentimentToMessages(null, data.map(({ data }) => data), null, context.options);
  const sentimentsAvg = averageSentiments(sentiments);
  roundSentimentScoreOnMessages(data.map(({ data }) => data));
  await serveMessages(context, data, {
    ttl: 1440,
    extra: {
      sentiments: transformAveragesForDigestHTTP(sentimentsAvg)
    }
  });

  if (!context.options.keep) {
    clearSquelched(context);
  }
}

function dynRequireFrom (dir, addedCb, opts = { pathReplace: null, dontAttachHelpers: false }) {
  const paths = {};
  const retObj = fs.readdirSync(dir).reduce((a, dirEnt) => {
    const fPath = path.resolve(path.join(dir, dirEnt));
    const fParsed = path.parse(fPath);

    if (!fs.statSync(fPath).isDirectory() && fParsed.ext === '.js' && fParsed.name !== 'index') {
      if (addedCb) {
        addedCb(fPath);
      }

      if (opts.pathReplace) {
        fParsed.name = fParsed.name.replaceAll(opts.pathReplace.from, opts.pathReplace.to);
      }

      paths[fParsed.name] = fPath;

      return {
        [fParsed.name]: require(fPath),
        ...a
      };
    }

    return a;
  }, {});

  if (!opts.dontAttachHelpers) {
    retObj.__resolver = (name) => require.cache[require.resolve(paths[name])];
    retObj.__refresh = () => {
      Object.values(paths).forEach((modPath) => {
        delete require.cache[require.resolve(modPath)];
        require(require.resolve(modPath));
      });
    };
  }

  return retObj;
}

const aliveKey = (network, chanId, event = 'aliveness', type = 'pmchan') => `${PREFIX}:${type}:${event}:${chanId}:${network}`;

const persistOrClearPmChan = async (network, chanId, persist = true) => {
  const ak = aliveKey(network, chanId);
  const alertKey = aliveKey(network, chanId, 'removalWarning');
  await scopedRedisClient(async (r) => {
    const rc = r.pipeline();
    await (persist ? rc.persist(ak) : rc.del(ak));
    await rc.del(alertKey);
    await rc.exec();
  });
};

const formatKVsWithOptsDefaults = {
  delim: ':\t',
  nameBoundary: '`'
};

function formatKVsWithOpts (obj, opts) {
  opts = { ...formatKVsWithOptsDefaults, ...opts };
  let { delim, sortByValue, nameBoundary } = opts;
  console.debug('formatKVsWithOpts USING OPTS', opts);
  const typeFmt = (v, k) => {
    switch (typeof v) {
      case 'object':
        return ['...'];

      case 'boolean':
        return [v ? ':white_check_mark:' : ':x:'];

      case 'number':
      {
        const nv = Number(v);

        if (k.match(/^t(?:ime)?s(?:tamp)?$/ig)) {
          return [new Date(nv).toDRCString(), Number(nv)];
        }

        return [nv];
      }

      default:
        return [v];
    }
  };

  const vFmt = (v, k) => {
    const [primary, secondary] = typeFmt(v, k);
    return `**${primary}**${secondary ? ` (_${secondary}_)` : ''}`;
  };

  const sorter = (a, b) => {
    if (typeof sortByValue === 'boolean' && sortByValue) {
      sortByValue = 1;
    }

    if (typeof sortByValue === 'number') {
      return a[1] + (b[1] * sortByValue);
    }

    return a[0].localeCompare(b[0]);
  };

  const maxPropLen = Object.keys(obj).reduce((a, k) => a > k.length ? a : k.length, 0) + 1;
  return Object.entries(obj).sort(sorter)
    .filter(([, v]) => typeof (v) !== 'function')
    .map(([k, v]) =>
      `${nameBoundary}${k.padStart(maxPropLen, ' ')}${nameBoundary}` +
      `${delim}${vFmt(v, k)}`
    ).join('\n');
}

module.exports = {
  // TODO: obvs remove these eventually in favor of direct imports by consuming code...
  ...require('./lib/contextMenus'),
  ...require('./lib/listMgmtUCGenerators'),
  ...require('./lib/serveMessages'),
  ...require('./lib/strings'),
  senderNickFromMessage,
  isHTTPRunning,

  dynRequireFrom,
  createArgObjOnContext,

  getNetworkAndChanNameFromUCContext (context) {
    const [netStub, chanId] = context.options._;
    let network, channelName;
    console.warn('getNetworkAndChanNameFromUCContext', netStub, chanId);

    if (context.discordMessage) {
      const chanObj = context.channelsById[context.discordMessage.channelId];
      if (!network) {
        network = context.channelsById[chanObj?.parent]?.name ?? null;
      }
      if (!channelName) {
        channelName = chanObj?.name;
      }
    }

    if (netStub && (!network && !channelName)) {
      network = matchNetwork(netStub).network;

      if (chanId) {
        const chanMatch = [...chanId.matchAll(CHANNELS_PATTERN)];

        if (chanMatch.length) {
          channelName = context.channelsById[chanMatch[0][1]].name;
        }
      }
    }

    console.warn('getNetworkAndChanNameFromUCContext -->', { network, channelName });
    return { network, channelName };
  },

  async isNickInChan (nick, channel, network, regOTHandler) {
    const retProm = new Promise((resolve) => {
      regOTHandler('irc:nickInChanResponse', [nick, channel, network].join('_'), async (data) => resolve(data));
    });

    await scopedRedisClient(async (client, prefix) => client.publish(prefix, JSON.stringify({
      type: 'discord:nickInChanReq',
      data: {
        nick,
        channel,
        network
      }
    })));

    return retProm;
  },

  messageIsFromAllowedSpeaker (data, { sendToBotChan = () => {} }) {
    // is from a webhook "user" we created to give messages the IRC user's nickname
    if (data?.author.bot && data?.author.discriminator === '0000' && data?.author.id === data?.webhookId) {
      return false;
    }

    if (!data.author || !config.app.allowedSpeakers.includes(data.author.id)) {
      if (data.author && data.author.id !== config.discord.botId) {
        sendToBotChan('`DISALLOWED SPEAKER` **' + data.author.username +
          '#' + data.author.discriminator + '**: ' + data.content);
        console.error('DISALLOWED SPEAKER', typeof data.author, data.author, data.content);
      }

      return false;
    }

    return true;
  },

  async persistMessage (key, messageType, network, msgObj) {
    if (!config.user.persistMentions) {
      return;
    }

    if (!msgObj.timestamp) {
      console.warn('Can\'t persist without timestamp!', msgObj);
      return;
    }

    return scopedRedisClient(async (rClient) => {
      key = [key, messageType, network, 'stream'].join(':');
      const msgKey = ':' + [Number(msgObj.timestamp), nanoid()].join(':');
      const fullKey = key + msgKey;
      const msgId = await rClient.xadd(key, '*', 'message', msgKey);
      await rClient.set(fullKey, JSON.stringify({ __drcMsgId: msgId, ...msgObj }));
      return { msgId, msgKey };
    });
  },

  async cacheMessageAttachment (context, attachmentURL) {
    if (!(await isHTTPRunning(context.registerOneTimeHandler, context.removeOneTimeHandler))) {
      return;
    }

    const retProm = new Promise((resolve) => {
      context.registerOneTimeHandler('http:cacheMessageAttachementResponse', attachmentURL, async (data) => resolve(data));
    });

    await scopedRedisClient(async (client, prefix) => client.publish(prefix, JSON.stringify({
      type: 'discord:cacheMessageAttachementRequest',
      data: { attachmentURL }
    })));

    return retProm;
  },

  formatKVsWithOpts,

  formatKVs (obj, delim = ':\t') {
    return formatKVsWithOpts(obj, { delim });
  },

  aliveKey,

  ticklePmChanExpiry: async (network, chanId) => {
    if (!network || !chanId) {
      console.error('ticklePmChanExpiry bad args', network, chanId);
      return null;
    }

    const ak = aliveKey(network, chanId);
    const curTtl = await scopedRedisClient((rc) => rc.ttl(aliveKey(network, chanId)));

    if (curTtl === -1) {
      // this key has been set to persist forever, so don't tickle the expiry!
      return;
    }

    const nDate = new Date();
    const alertMins = Math.floor(config.discord.privMsgChannelStalenessTimeMinutes * (1 - config.discord.privMsgChannelStalenessRemovalAlert));
    const alertKey = aliveKey(network, chanId, 'removalWarning');
    const remainMins = config.discord.privMsgChannelStalenessTimeMinutes - alertMins;

    const setObj = {
      stalenessPercentage: Math.floor(config.discord.privMsgChannelStalenessRemovalAlert * 100),
      origMins: config.discord.privMsgChannelStalenessTimeMinutes,
      alertMins,
      remainMins,
      humanReadable: {
        origMins: fmtDuration(0, false, config.discord.privMsgChannelStalenessTimeMinutes * 60 * 1000),
        alertMins: fmtDuration(0, false, alertMins * 60 * 1000),
        remainMins: fmtDuration(0, false, remainMins * 60 * 1000)
      }
    };

    await scopedRedisClient(async (rc) =>
      rc.multi()
        .set(ak, JSON.stringify(setObj))
        .expire(ak, config.discord.privMsgChannelStalenessTimeMinutes * 60)
        .set(alertKey, chanId)
        .expire(alertKey, alertMins * 60)
        .exec()
    );

    console.log('ticklePmChanExpiry', chanId, network, ak, 'expires',
      new Date(Number(nDate) + (config.discord.privMsgChannelStalenessTimeMinutes * 60 * 1000)).toDRCString());

    return setObj;
  },

  persistPmChan: async (network, chanId) => persistOrClearPmChan(network, chanId),

  removePmChan: async (network, chanId) => persistOrClearPmChan(network, chanId, false),

  clearSquelched,
  digest
};
