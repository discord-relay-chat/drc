'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { hrtime } = require('process');
const { spawn } = require('child_process');
const config = require('config');
const { nanoid } = require('nanoid');
const { PREFIX, matchNetwork, fmtDuration, scopedRedisClient } = require('../util');
const { MessageMentions: { CHANNELS_PATTERN }, MessageEmbed } = require('discord.js');

function senderNickFromMessage (msgObj) {
  // message was sent via our username-interposing webhooks, so we can extract the nick directly
  if (msgObj?.author.bot && msgObj?.author.discriminator === '0000') {
    console.debug('senderNickFromMessage IS A IRC USER INTERPOSED ->', msgObj?.author.username);
    return msgObj?.author.username;
  }

  console.debug('senderNickFromMessage MISSED', msgObj);
}

function contextMenuHandlerCommonInitial (context, ...a) {
  const [interaction] = a;
  const message = interaction?.options.get('message')?.message;
  const senderNick = senderNickFromMessage(message);
  return { interaction, message, senderNick };
}

async function _contextMenuCommonHandler (ephemeral, innerHandler, context, ...a) {
  const { interaction, message, senderNick } = contextMenuHandlerCommonInitial(context, ...a);
  let replyEmbed = new MessageEmbed()
    .setTitle('Unable to determine IRC nickname from that message. Sorry!')
    .setTimestamp();

  if (message && senderNick) {
    replyEmbed = await innerHandler({ interaction, message, senderNick });
  }

  interaction.reply({
    embeds: [replyEmbed],
    ephemeral
  }).catch(console.error);
}

async function contextMenuCommonHandlerNonEphemeral (innerHandler, context, ...a) {
  return _contextMenuCommonHandler(false, innerHandler, context, ...a);
}

async function contextMenuCommonHandler (innerHandler, context, ...a) {
  return _contextMenuCommonHandler(true, innerHandler, context, ...a);
}

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

async function isHTTPRunning (regOTHandler, rmOTHandler, timeoutSeconds = 2) {
  const reqId = nanoid();
  const retProm = new Promise((resolve) => {
    const timeoutHandle = setTimeout(() => resolve(null), timeoutSeconds * 1000);
    regOTHandler('http:isHTTPRunningResponse', reqId, async (data) => {
      clearTimeout(timeoutHandle);
      rmOTHandler('http:isHTTPRunningResponse', reqId);
      resolve(data);
    });
  });

  await scopedRedisClient(async (client, prefix) => client.publish(prefix, JSON.stringify({
    type: 'discord:isHTTPRunningRequest',
    data: { reqId }
  })));

  return retProm;
}

// this and servePage should be refactored together, they're very similar
async function serveMessages (context, data, opts = {}) {
  const name = nanoid();

  if (!data.length) {
    context.sendToBotChan(`No messages for \`${context.network}\` were found.`);
    return;
  }

  context.registerOneTimeHandler('http:get-req:' + name, name, async () => {
    await scopedRedisClient(async (r) => {
      await r.publish(PREFIX, JSON.stringify({
        type: 'http:get-res:' + name,
        data: {
          network: context.network,
          elements: data
        }
      }));
    });
  });

  const options = Object.assign(opts, context.options);
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
}

async function clearSquelched (context, ...a) {
  return context.redis.del([context.key, 'squelch'].join(':'));
}

async function digest (context, ...a) {
  const data = (await context.redis.lrange([context.key, 'squelch'].join(':'), 0, -1)).map(JSON.parse).reverse();

  await serveMessages(context, data, { ttl: 1440 });

  if (!context.options.keep) {
    clearSquelched(context);
  }
}

// this still doesn't work when containerized - even with the host daemon - because of the need
// to write files, both a temporary one that the gnuplot executable can read and the output image
// BUT i'm not removing it because I really want to fix it... someday...
async function plotMpmData (timeLimitHours = config.app.stats.mpmPlotTimeLimitHours) {
  if (!config.app.stats.plotEnabled) {
    return;
  }

  let maxY = 0;
  const nowNum = Number(new Date());
  const timeLimit = nowNum - timeLimitHours * 60 * 60 * 1000;
  // double it to be safe, in case config.app.statsSilentPersistFreqMins wasn't always what it is now
  const queryLim = (timeLimitHours / (config.app.statsSilentPersistFreqMins / 60)) * 2;
  const startTime = hrtime.bigint();
  const data = (await scopedRedisClient((rc) => rc.lrange(`${PREFIX}:mpmtrack`, 0, queryLim)))
    .map(JSON.parse)
    .filter((x) => x.timestamp >= timeLimit)
    .map((x) => {
      maxY = Math.max(x.chatMsgsMpm, x.totMsgsMpm, maxY);
      return [Number((nowNum - x.timestamp) / (1000 * 60 * 60)).toFixed(1), x.chatMsgsMpm, x.totMsgsMpm];
    })
    .reverse();

  console.log(`plotMpmData: querying ${queryLim} elements & filtering into ${data.length} ` +
    `took ${(Number(hrtime.bigint() - startTime) / 1e6).toFixed(2)}ms ` +
    `(timeLimitHours=${timeLimitHours}, statsSilentPersistFreqMins=${config.app.statsSilentPersistFreqMins})`);

  if (data?.length) {
    const fName = config.app.stats.mpmPlotOutputPath;
    const tName = path.join(os.tmpdir(), `drc-mpmplot.${nanoid()}.dat`);
    await fs.promises.writeFile(tName, data.map(x => x.join(' ')).join('\n'));

    const xtics = [];
    const gapSize = Math.ceil(data.length / 10);
    for (let i = 0; i < data.length; i += gapSize) {
      xtics.push(`"${data[i][0]}" ${i}`);
    }

    let gnuplotCmds = ['set grid'];

    if (maxY > 100) { // TODO: stddev
      gnuplotCmds.push('set logscale y');
    }

    gnuplotCmds = [
      ...gnuplotCmds,
      `set yrange [2:${Math.ceil(maxY * 1.05)}]`,
      'set tics nomirror',
      'set logscale y',
      `set xtics(${xtics.join(', ')})`,
      'set xlabel "⬅️ the past (time, in hours) now ➡️"',
      'set key Left left reverse box samplen 2 width 2',
      'set grid x lt 1 lw .75 lc "gray40"',
      `set title "Messages per minute, sample size: ${data.length}\\nAs of ${new Date().toDRCString()}" textcolor rgb "white"`,
      'set border lw 3 lc rgb "white"',
      'set xlabel textcolor rgb "white"',
      'set ylabel textcolor rgb "white"',
      'set key textcolor rgb "white"',
      'set terminal pngcairo transparent enhanced font "helvetica, 11" fontscale 1.0',
      `set output '${fName}'`,
      'set style fill transparent solid 0.6 noborder',
      'plot ' + [
        `'${tName}' using 0:3 with filledcurve y1=0 lc rgb "web-blue" title 'Total'`,
        `'${tName}' using 0:2 with filledcurve y1=0 lc rgb "dark-turquoise" title 'Chat'`
      ].join(', ')
    ].join('\n');

    return new Promise((resolve, reject) => {
      const gnuplot = spawn('gnuplot');

      gnuplot.on('close', () => {
        fs.unlinkSync(tName);
        resolve(fName);
      });

      gnuplot.on('error', reject);

      gnuplot.stdin.write(gnuplotCmds, 'utf8');
      gnuplot.stdin.end();
    });
  }

  return null;
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

const discordEscapeRx = /([*_`])/g;
function simpleEscapeForDiscord (s) {
  if (typeof (s) !== 'string' || s.length === 0) {
    return s;
  }

  if (s.indexOf('\\') !== -1) {
    // assume any escape in `s` means it has already been escaped
    return s;
  }

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
    console.debug(`simpleEscapeForDiscord "${s}" -> "${accum}"`);
  }

  return accum;
}

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

    const argStr = () => {
      if (a.length < 3) {
        throw new Error(`Not enough args for ${cmd}!`);
      }

      return a.slice(2).join(' ');
    };

    return scopedRedisClient(async (redis) => {
      switch (cmd) {
        case 'add':
          await redis.sadd(key, argStr());
          break;
        case 'clear':
          // this really should be a button for confirmation instead of hardcoded!
          if (!disallowClear) {
            await redis.del(key);
          }
          break;
        case 'remove':
          await redis.srem(key, argStr());
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

const formatKVsWithOptsDefaults = { delim: ':\t' };

function formatKVsWithOpts (obj, opts) {
  opts = { ...formatKVsWithOptsDefaults, ...opts };
  const { delim, sortByValue } = opts;
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
    if (typeof sortByValue === 'number') {
      return a[1] + (b[1] * sortByValue);
    }

    return a[0].localeCompare(b[0]);
  };

  const maxPropLen = Object.keys(obj).reduce((a, k) => a > k.length ? a : k.length, 0) + 1;
  return Object.entries(obj).sort(sorter).map(([k, v]) => `\`${k.padStart(maxPropLen, ' ')}\`${delim}${vFmt(v, k)}`).join('\n');
}

module.exports = {
  plotMpmData,
  dynRequireFrom,
  simpleEscapeForDiscord,
  generateListManagementUCExport,
  createArgObjOnContext,
  senderNickFromMessage,
  contextMenuCommonHandler,
  contextMenuCommonHandlerNonEphemeral,

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

  async servePage (context, data, renderType, callback) {
    if (!context || !data || !renderType) {
      throw new Error('not enough args');
    }

    const name = nanoid();

    context.registerOneTimeHandler('http:get-req:' + name, name, async () => {
      await scopedRedisClient(async (r) => {
        await r.publish(PREFIX, JSON.stringify({
          type: 'http:get-res:' + name,
          data
        }));

        if (callback) {
          callback(context);
        }
      });
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

  serveMessages,

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

  isHTTPRunning,

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

  generatePerChanListManagementUCExport (commandName, additionalCommands, enforceChannelSpec = true) {
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
