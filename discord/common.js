'use strict';

const fs = require('fs');
const path = require('path');
const config = require('config');
const { nanoid } = require('nanoid');
const { PREFIX, matchNetwork, fmtDuration, scopedRedisClient, isXRunning, fqUrlFromPath, resolveNameForIRC } = require('../util');
const { MessageMentions: { CHANNELS_PATTERN }, MessageEmbed } = require('discord.js');
const httpCommon = require('../http/common');

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

async function _contextMenuCommonHandler (ephemeral, defer, innerHandler, context, ...a) {
  const { interaction, message, senderNick } = contextMenuHandlerCommonInitial(context, ...a);
  let replyEmbed = new MessageEmbed()
    .setTitle('Unable to determine IRC nickname from that message. Sorry!')
    .setTimestamp();

  if (defer) {
    await interaction.deferReply({ ephemeral });
  }

  if (message && senderNick) {
    replyEmbed = await innerHandler({ interaction, message, senderNick });
  }

  return (defer ? interaction.editReply : interaction.reply).bind(interaction)({
    embeds: [replyEmbed],
    ephemeral
  });
}

async function contextMenuCommonHandlerNonEphemeral (innerHandler, context, ...a) {
  return _contextMenuCommonHandler(false, false, innerHandler, context, ...a);
}

async function contextMenuCommonHandler (innerHandler, context, ...a) {
  return _contextMenuCommonHandler(true, false, innerHandler, context, ...a);
}

async function contextMenuCommonHandlerDefered (innerHandler, context, ...a) {
  return _contextMenuCommonHandler(true, true, innerHandler, context, ...a);
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

async function isHTTPRunning (regOTHandler, rmOTHandler, timeoutMs = 500) {
  return isXRunning('HTTP', { registerOneTimeHandler: regOTHandler, removeOneTimeHandler: rmOTHandler }, timeoutMs);
}

const serveMessagesLocalFSOutputFormats = {
  html: (data, network) => {
    return httpCommon.renderTemplate('digest', { network, elements: data }).body;
  },

  json: (data) => JSON.stringify(data.reduce((a, {
    timestamp, data: {
      type, nick, ident, hostname, target, message, tags
    }
  }) => ([...a, {
    timestampMs: timestamp, type, nick, ident, hostname, target, message, tags
  }]), [])),

  jsonl: (data) => data.reduce((a, {
    timestamp, data: {
      type, nick, ident, hostname, target, message, tags
    }
  }) => (a += JSON.stringify({
    timestampMs: timestamp, type, nick, ident, hostname, target, message, tags
  }) + '\n'), '')
};

async function serveMessagesLocalFS (context, data, opts = {}) {
  const outpath = 'queries.out';
  const { localQueryOutputFormat } = config.app.log;
  const logPath = path.join(path.resolve(config.irc.log.path), outpath);

  if (!fs.existsSync(logPath)) {
    await fs.promises.mkdir(logPath);
  }

  const logname = `${context.network}_${new Date().toISOString()}`.replaceAll(':', '') +
    '.' + localQueryOutputFormat;
  const fname = path.join(logPath, logname);
  await fs.promises.writeFile(fname,
    serveMessagesLocalFSOutputFormats[localQueryOutputFormat](data, context.network));
  console.log('Wrote', fname);
  context.sendToBotChan(`**${data.length}** messages for \`${context.network}\` ` +
    `written to **${logname}** in the logging \`${outpath}\` subdirectory.`);
}

// this and servePage should be refactored together, they're very similar
async function serveMessages (context, data, opts = {}) {
  if (!config.http.enabled || !(await isHTTPRunning(context.registerOneTimeHandler, context.removeOneTimeHandler))) {
    return serveMessagesLocalFS(context, data, opts);
  }

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

  await scopedRedisClient((client, prefix) => client.publish(prefix, JSON.stringify({
    type: 'discord:createGetEndpoint',
    data: {
      name,
      renderType: 'digest',
      options
    }
  })));

  const embed = new MessageEmbed()
    .setColor('DARK_GOLD')
    .setTitle(`Serving **${data.length}**-message digest for \`${context.network}\``)
    .setDescription(fqUrlFromPath(name));

  if (options.ttl === -1) {
    embed.addField('Forever URL', fqUrlFromPath(`static/${name}.html`));
  } else {
    const ttlSecs = options.ttl ? options.ttl * 60 : config.http.ttlSecs;
    embed.addField('Expires', `${ttlSecs / 60} minutes`);
  }

  context.sendToBotChan({ embeds: [embed] }, true);
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

async function convertDiscordChannelsToIRCInString (targetString, context, network) {
  if (targetString.match(CHANNELS_PATTERN)) {
    const [chanMatch, channelId] = [...targetString.matchAll(CHANNELS_PATTERN)][0];
    const ircName = '#' + await resolveNameForIRC(network, context.getDiscordChannelById(channelId).name);
    targetString = targetString.replace(chanMatch, ircName);
  }
  return targetString;
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
  dynRequireFrom,
  simpleEscapeForDiscord,
  convertDiscordChannelsToIRCInString,
  generateListManagementUCExport,
  createArgObjOnContext,
  senderNickFromMessage,
  contextMenuCommonHandler,
  contextMenuCommonHandlerNonEphemeral,
  contextMenuCommonHandlerDefered,

  getNetworkAndChanNameFromUCContext (context) {
    const [netStub, chanId] = context.options._;
    let network, channelName;
    console.warn('getNetworkAndChanNameFromUCContext', netStub, chanId);

    if (netStub) {
      network = matchNetwork(netStub).network;

      if (chanId) {
        const chanMatch = [...chanId.matchAll(CHANNELS_PATTERN)];

        if (chanMatch.length) {
          channelName = context.channelsById[chanMatch[0][1]].name;
        }
      }
    }

    if (context.discordMessage) {
      const chanObj = context.channelsById[context.discordMessage.channelId];
      if (!network) {
        network = context.channelsById[chanObj?.parent]?.name ?? null;
      }
      if (!channelName) {
        channelName = chanObj?.name;
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
