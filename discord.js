'use strict';

const inq = require('inquirer');
const config = require('./config');
const crypto = require('crypto');
const { Client, Intents, MessageEmbed, MessageActionRow, MessageButton, DiscordAPIError } = require('discord.js');
const Redis = require('ioredis');
const yargs = require('yargs');
const { fetch } = require('undici');
const ipcMessageHandler = require('./discord/ipcMessage');
const { banner, setDefaultFont } = require('./discord/figletBanners');
const userCommands = require('./discord/userCommands');
const { formatKVs, aliveKey, ticklePmChanExpiry } = require('./discord/common');
const { plotMpmData } = require('./discord/plotting');
const eventHandlers = require('./discord/events');
const registerContextMenus = require('./discord/contextMenus');
const parsers = require('./lib/parsers');
const { loadAliases, tryResolvingAlias } = require('./discord/lib/ucAliases');
const UCHistory = require('./discord/userCommandHistory');
const {
  PREFIX,
  replaceIrcEscapes,
  PrivmsgMappings,
  NetworkNotMatchedError,
  AmbiguousMatchResultError,
  UserCommandNotFound,
  scopedRedisClient,
  fmtDuration
} = require('./util');
const { wrapUrls } = require('./lib/wrapUrls');
const chunk = require('./lib/chunk');

require('./logger')('discord');
require('./lib/promRedisExport')('discord');

const INTENTS = [
  Intents.FLAGS.GUILDS,
  Intents.FLAGS.GUILD_MESSAGES,
  Intents.FLAGS.GUILD_MEMBERS,
  Intents.FLAGS.DIRECT_MESSAGES,
  Intents.FLAGS.GUILD_MESSAGE_REACTIONS
];

const client = new Client({
  intents: INTENTS
});

const redisClient = new Redis(config.redis.url);
const categories = {};
const categoriesByName = {};
const channelsById = {};
const channelsByName = {};
const stats = {
  messages: {
    total: 0,
    ignored: 0,
    mentions: 0,
    types: {},
    channels: {}
  },
  messagesLastAnnounce: {},
  errors: 0,
  sinceLast: {
    quits: []
  },
  upSince: new Date(),
  lastAnnounce: new Date()
};

let _isReconnect = false;
function isReconnect () { return _isReconnect; }

let listenedTo = 0;
function _listenedToMutate (byVal) {
  listenedTo += byVal;
  client.user.setActivity(`${listenedTo} channels`, { type: 'LISTENING' });
}

const listenedToMutate = {
  addOne: _listenedToMutate.bind(null, 1),
  subOne: _listenedToMutate.bind(null, -1)
};

const oneTimeMsgHandlers = {};
function registerOneTimeHandler (event, discriminator, handlerFunc) {
  let discrimObj = oneTimeMsgHandlers[event];

  if (!discrimObj) {
    discrimObj = oneTimeMsgHandlers[event] = {};
  }

  if (!discrimObj[discriminator]) {
    discrimObj[discriminator] = [];
  }

  console.debug(`REG'ed OTH for ${event} discrim ${discriminator}`);
  discrimObj[discriminator].push(handlerFunc);
}

function removeOneTimeHandler (event, discriminator) {
  return delete oneTimeMsgHandlers[event][discriminator];
}

const channelMessageHandlers = {};
function registerChannelMessageHandler (channelId, handler) {
  channelMessageHandlers[channelId] = handler;
}

const buttonHandlers = {};
function registerButtonHandler (buttonId, handlerFunc) {
  if (!buttonHandlers[buttonId]) {
    buttonHandlers[buttonId] = [];
  }

  buttonHandlers[buttonId].push(handlerFunc);
}

const allowedSpeakersMentionString = (s = ['[', ']']) => {
  if (!config.app.allowedSpeakersHighlight) {
    return '';
  }

  if (!config.app.allowedSpeakers.length) {
    return '';
  }

  return s[0] + config.app.allowedSpeakers.map(x => `<@${x}>`).join(' ') + s[1];
};

let sendToBotChan = (...a) => console.error('sendToBotChan not initialized!', ...a);

// SITE CHECK: MOVE THIS!
async function siteCheck () {
  const { slow, fast } = config.siteCheck.frequencyMinutes;
  const siteChecks = userCommands('siteChecks');

  const networks = await siteChecks({}, 'listAllNetworks');
  let slowQueue = [...config.siteCheck.sites];
  for (const network of networks) {
    const checks = await siteChecks({}, network);
    slowQueue = slowQueue.concat(checks);
  }

  const fastQueue = [];

  const _msg = (msg, level = 'log') => {
    console[level]('siteCheck: ' + msg);
    sendToBotChan(allowedSpeakersMentionString(['', '']) + ': ' + msg);
  };

  const slowSuccess = () => {};
  const slowFail = (check, index, res) => {
    _msg(`🚨 ${check} is unreachable! (${res?.status}). Checking every ${fast} minutes now...`, 'error');
    fastQueue.push(...slowQueue.splice(index, 1));
  };
  const fastFail = () => {};
  const fastSuccess = (check, index, res) => {
    _msg(`${check} is reachable again!`);
    slowQueue.push(...fastQueue.splice(index, 1));
  };

  async function loop (freq, q, onSuccess, onFail) {
    for (let index = 0; index < q.length; index++) {
      const check = q[index];
      let fRes;
      try {
        fRes = await fetch(check);
      } catch (err) {
        console.error(`siteCheck: fetch threw for ${check}: ${err.message}`);
        console.debug(err);
      }

      if (fRes?.ok) {
        onSuccess(check, index, fRes);
      } else {
        onFail(check, index, fRes);
      }
    }

    if (q.length) {
      console.info(`siteCheck freq=${freq}m queue (${q.length} elements): ${q.join(', ')}`);
    }
    setTimeout(loop.bind(null, freq, q, onSuccess, onFail), freq * 60 * 1000);
  }

  loop(slow, slowQueue, slowSuccess, slowFail);
  loop(fast, fastQueue, fastSuccess, fastFail);
}

const pendingAliveChecks = {};
async function alivenessCheck () {
  const msg = userCommands('msg');
  const ac = userCommands('aliveChecks');
  const ctx = {
    channelsById,
    redis: new Redis(config.redis.url)
  };

  const networks = await ac(ctx, 'listAllNetworks');
  for (const network of networks) {
    const checks = await ac({}, network);
    for (const check of checks) {
      console.info(`Running aliveness check "${check}" on ${network}`);
      const [nick, ...messageComps] = check.split(/\s+/);

      if (pendingAliveChecks[nick]) {
        console.error(`Alive check for ${nick} is still pending!`);
        continue;
      }

      pendingAliveChecks[nick] = setTimeout(() => {
        console.error(`🚨 Alive check for ${nick} popped!`);
        sendToBotChan(allowedSpeakersMentionString(['', '']) + ': ' +
          `🚨 Aliveness check for **${nick}** on \`${network}\` failed!`);
        clearTimeout(pendingAliveChecks[nick]);
        delete pendingAliveChecks[nick];
      }, 30 * 1000);

      try {
        await msg(ctx, network, nick, ...messageComps);
      } catch (e) {
        console.error(`Aliveness check for ${network}/${nick} threw!`, e);
      }
    }
  }

  ctx.redis.disconnect();
  setTimeout(alivenessCheck, 10 * 60 * 1000);
}

setTimeout(alivenessCheck, 15 * 1000);

const ignoreSquelched = [];

setDefaultFont(config.figletBanners.font);

console.log(`${PREFIX} Discord controller starting...`);

const formatForAllowedSpeakerResponse = (s, raw = false) =>
  (!raw
    ? s
    : (s instanceof MessageEmbed ? { embeds: [s] } : s));

let clientOnSigint = () => {};
client.once('ready', async () => {
  const commandAliases = await loadAliases();
  console.log(`Loaded ${Object.keys(commandAliases).length} user command aliases`);

  console.log('Ready!');

  client.user.setStatus('idle');
  client.user.setActivity('the IRC daemon...', { type: 'LISTENING' });

  const onExit = async (s) => {
    sendToBotChan({
      embeds: [
        new MessageEmbed().setDescription('\n```\n' + (await banner(s)) + '\n```\n')
      ]
    }, true);
    client.user.setStatus('invisible');
    client.user.setActivity('nothing! (I\'m offline!)', { type: 'LISTENING' });
  };

  clientOnSigint = () => onExit('Bye!');

  const chanCache = client.channels.cache.values();

  try {
    if (config.app.allowedSpeakersRoleId) {
      const guild = await client.guilds.fetch(config.discord.guildId);
      await guild.members.fetch();
      const role = await guild.roles.fetch(config.app.allowedSpeakersRoleId);

      if (!role) {
        throw new Error(`Role ${config.app.allowedSpeakersRoleId} doesn't exist!`);
      }

      const allowedSpeakerIds = [...role.members.map(u => u.id)];
      if (config.app.allowedSpeakersMerge(allowedSpeakerIds)) {
        console.log(`Added ${allowedSpeakerIds.length} users to allowed speakers group from role ${config.app.allowedSpeakersRoleId}`);
      }
    }
  } catch (e) {
    console.error('allowedSpeakersRoleId handling: ', e);
  }

  // first pass to build channelsById & categories
  for (const chan of chanCache) {
    channelsById[chan.id] = { name: chan.name, parent: chan.parentId };

    if (!chan.parentId) {
      console.log(`Found category '${chan.name}' with ID ${chan.id}`);
      categories[chan.id] = {
        name: chan.name,
        channels: {}
      };

      categoriesByName[chan.name] = [chan.id, ...(categoriesByName[chan.name] ?? [])];
      channelsByName[chan.name] = {};
    }
  }

  console.debug('FIRST PASS RES', categories);

  // second pass to build channels in categories
  for (const chan of client.channels.cache.values()) {
    const { id, name, parentId } = chan;
    if (chan.parentId && categories[chan.parentId]) {
      console.log(`Found channel ${chan.name} (${chan.id}) in category '${categories[chan.parentId].name}' (${chan.parentId})`);
      categories[chan.parentId].channels[chan.id] = { id, name, parentId, parent: parentId };
      channelsByName[categories[chan.parentId].name][chan.name] = chan.id;
    }
  }

  console.debug('READY STRUCTS');
  console.debug('channelsById', channelsById);
  console.debug('categoriesByName', categoriesByName);

  if (config.irc.quitMsgChanId) {
    const __sendToBotChan = async (s, raw = false, fromUserScript = false) => {
      if (!s || (typeof s === 'string' && !s?.length)) {
        console.error('sendToBotChan called without message!', s, raw);
        return;
      }

      let truncTail;
      if (!raw && s.length > config.discord.maxMsgLength) {
        console.error('MSG TOO LARGE -- TRUNCATING:');
        console.debug(s);
        truncTail = s.slice(config.discord.maxMsgLength - 50);
        s = s.slice(0, config.discord.maxMsgLength - 50) + ' [TRUNCATED]';
      }

      let toSend;
      try {
        // an admission that the `raw` flag was a terrible idea, because sometimes
        // callers don't use it but pass an object for `s` anyway. dammit.
        if (!raw && typeof s !== 'string') {
          console.debug(`sendToBotChan raw fixup: ${typeof s}`, s);
          s = '```json\n' + JSON.stringify(s, null, 2) + '\n```';
        }

        if (!raw) {
          s = wrapUrls(replaceIrcEscapes(s));
        }

        toSend = formatForAllowedSpeakerResponse(s, raw);
        let chanId = config.irc.quitMsgChanId;
        if (fromUserScript && config.discord.userScriptOutputChannelId) {
          chanId = config.discord.userScriptOutputChannelId;
        }

        await client.channels.cache.get(chanId).send(toSend);
      } catch (e) {
        console.error('sendToBotChan .send() threw!', e);
        console.debug(s);
        ++stats.errors;

        setTimeout(() => sendToBotChan(`\`ERROR\` Discord send failure! "${e.message}"\n>>> ` + e.stack), 150);
      }

      return (truncTail ? sendToBotChan(truncTail, raw) : toSend);
    };

    // serialize bot-chan sends to a cadence of 2Hz, to avoid rate limits
    const stbcQueue = [];
    const stbcServicer = async () => {
      if (stbcQueue.length > 0) {
        const [s, raw, fUC] = stbcQueue.shift();
        await __sendToBotChan(s, raw, fUC);
      }

      setTimeout(stbcServicer, 500);
    };

    sendToBotChan = async (s, raw = false, fromUserCommand = false) => stbcQueue.push([s, raw, fromUserCommand]);

    stbcServicer();
  }

  sendToBotChan({
    embeds: [
      new MessageEmbed().setDescription('\n```\n' + (await banner('Hi!')) + '\n```\n\n')
    ]
  }, true);

  siteCheck();

  const getDiscordChannelById = (id) => client.channels.cache.get(id);
  let allowedSpeakerCommandHandler = () => {
    throw new Error('allowedSpeakerCommandHandler not initialized! not configured?');
  };

  if (config.app.allowedSpeakers.length) {
    allowedSpeakerCommandHandler = async (data, toChanId, {
      autoPrefixCurrentCommandChar = false
    } = {}) => {
      const trimContent = data.content.replace(/^\s+/, '');

      if (!autoPrefixCurrentCommandChar && trimContent[0] !== config.app.allowedSpeakersCommandPrefixCharacter) {
        return;
      }

      const pipedHandler = parsers.parseMessageStringForPipes(trimContent, (content) =>
        allowedSpeakerCommandHandler(Object.assign({}, data, { content }), toChanId, { autoPrefixCurrentCommandChar }));

      if (pipedHandler) {
        return pipedHandler();
      }

      const aliasedTCList = trimContent.slice(autoPrefixCurrentCommandChar ? 0 : 1).split(/\s+/);
      const aliased = tryResolvingAlias(aliasedTCList[0]);
      console.warn('USE', aliased ? [aliased, ...aliasedTCList.slice(1)].join(' ') : trimContent);
      let { command, args } = parsers.parseCommandAndArgs(
        aliased ? [aliased, ...aliasedTCList.slice(1)].join(' ') : trimContent,
        {
          // must auto-prefix if aliased
          autoPrefixCurrentCommandChar: !!(aliased ?? autoPrefixCurrentCommandChar)
        }
      );
      console.log(trimContent, '-> user command parsed ->', { command, args, aliased });

      const fmtedCmdStr = '`' + `${command} ${args.join(' ')}` + '`';
      const redis = new Redis(config.redis.url);

      const zEvents = [];
      let resolvedName;
      try {
        const cmdFunc = userCommands(command);
        resolvedName = cmdFunc?.__resolvedFullCommandName ?? command;

        args = parsers.parseArgsForQuotes(args);
        console.debug('args parsed for quotes', args);

        // this should be removed ASAP in favor of scopedRedisClient,
        // but need to find all uses of it first...
        const publish = async (publishObj) => redis.publish(PREFIX, JSON.stringify(publishObj));
        const argObj = yargs(args).help(false).exitProcess(false).argv;
        console.log('Command args:', args, ' parsed into ', argObj);

        const createGuildChannel = async (channelName, channelOpts) =>
          client.guilds.cache.get(config.discord.guildId).channels.create(channelName, channelOpts);

        let localSender = sendToBotChan;

        if (toChanId) {
          localSender = async (msg, raw = false) => {
            let msgFormatted = formatForAllowedSpeakerResponse(msg, raw);
            const chan = client.channels.cache.get(toChanId);
            const _realSender = chan.__drcSend || chan.send.bind(chan);
            const privMsg = '_(Only visible to you)_';

            if (!raw) {
              msgFormatted = `${privMsg} ${!chan.__drcSend ? wrapUrls(msgFormatted) : msgFormatted}`;
            }

            try {
              await _realSender(msgFormatted, raw);

              if (raw) {
                await _realSender(privMsg);
              }
            } catch (err) {
              try {
                if (err instanceof DiscordAPIError) {
                  if (err.code === 50035 && err.httpStatus === 400) {
                    for (const chk of chunk(msgFormatted)) {
                      await _realSender(chk, raw);
                    }
                    return;
                  }
                }
                console.warn('send failed, falling back to bot chan', err);
                zEvents.push('chanSendFallback');
                return await client?.channels.cache.get(config.irc.quitMsgChanId).send(msgFormatted);
              } catch (iErr) {
                console.error('localSender/send failed!', iErr, toChanId, msg, chan);
                zEvents.push('localSenderFailed');
              }
            }
          };
        }

        if (!cmdFunc) {
          localSender(`\`${command}\` is not a valid DRC user command. Run \`${config.app.allowedSpeakersCommandPrefixCharacter}help\` to see all available commands.`);
          throw new UserCommandNotFound();
        }

        const context = {
          stats,
          redis,
          publish, // TODO: replace all uses of `redis` with `publish` (and others if needed)
          sendToBotChan: localSender,
          argObj,
          options: argObj, // much better name! use this from now on...
          registerOneTimeHandler,
          removeOneTimeHandler,
          createGuildChannel,
          registerChannelMessageHandler,
          registerButtonHandler,
          discordAuthor: data.author,
          ignoreSquelched,
          channelsById,
          categoriesByName,
          toChanId,
          getDiscordChannelById,
          discordMessage: data
        };

        if (argObj.help || argObj.h) {
          context.options._ = [resolvedName];
          zEvents.push('commandSuccess');
          return userCommands('help')(context);
        }

        const result = await cmdFunc(context, ...args);
        console.log(`Executed user command "${command}" (${resolvedName}) ` +
          (aliased ? `from alias "${aliasedTCList[0]}"` : '') +
        ' with result -->\n', result);

        let toBotChan;
        if (result && result.__drcFormatter) {
          toBotChan = await result.__drcFormatter();
        } else if (typeof result === 'string') {
          toBotChan = result;
        } else if (result) {
          toBotChan = '```json\n' + JSON.stringify(result, null, 2) + '\n```\n';
        }

        if (toBotChan) {
          localSender(toBotChan);
        }

        zEvents.push('commandSuccess');
      } catch (ucErr) {
        if (ucErr instanceof UserCommandNotFound) {
          console.warn('user comand not found!', command, ...args);
          zEvents.push('commandNotFound');
          return;
        }

        console.error('user command threw!\n\n', ucErr);

        if (ucErr instanceof NetworkNotMatchedError) {
          sendToBotChan(`Unable to find a matching network for "${ucErr.message}"`);
          zEvents.push('netNotMatched');
        } else if (ucErr instanceof AmbiguousMatchResultError) {
          sendToBotChan({
            embeds: [
              new MessageEmbed()
                .setTitle(`Ambiguous command name "\`${fmtedCmdStr.trim()}\`"`)
                .setColor('RED')
                .setDescription(ucErr.message)
            ]
          }, true);
        } else {
          sendToBotChan(fmtedCmdStr + `threw an error! (${ucErr.name}):` +
            ' `' + ucErr.message + '`');
          zEvents.push('otherError');
        }
      } finally {
        redis.disconnect();

        const chan = await getDiscordChannelById(data.channelId);
        const { hashKey } = await UCHistory.push(trimContent, resolvedName, {
          zEvents,
          sentBy: data.author?.tag ?? '<system>',
          sentIn: {
            channel: chan?.name ?? '<system>',
            guild: chan?.guild?.name ?? '<system>'
          }
        });

        scopedRedisClient(async (client, prefix) => {
          const keyArr = [prefix, 'userCommandCalls'];
          const zNewCounts = await Promise.all(
            zEvents.map((evName) => client.zincrby([...keyArr, evName].join(':'), '1', resolvedName ?? command))
          );
          console.log(`User command logged as ${hashKey}:`,
            command, 'is', resolvedName, '/ events:', zEvents, '->>', zNewCounts);
        });
      }
    };
  } else {
    delete eventHandlers.messageCreate;
  }

  const deletedBeforeJoin = {};
  const allowedSpeakersAvatars = [];
  const eventHandlerContext = {
    allowedSpeakersAvatars,
    sendToBotChan,
    channelMessageHandlers,
    client,
    allowedSpeakerCommandHandler,
    channelsById,
    categories,
    stats,
    deletedBeforeJoin,
    redisClient,
    redis: redisClient, // ugh
    channelsByName,
    listenedToMutate,
    buttonHandlers,
    registerButtonHandler,
    registerOneTimeHandler,
    removeOneTimeHandler,
    publish: async (publishObj) => redisClient.publish(PREFIX, JSON.stringify(publishObj))
  };

  Object.entries(eventHandlers).forEach(([eventName, handler]) => {
    if (eventName.indexOf('_') !== -1) {
      return;
    }

    console.log(`Registered handler for event "${eventName}"`);
    client.on(eventName, (...a) => handler(eventHandlerContext, ...a));
  });

  const uCfg = await scopedRedisClient(async (redis) => userCommands('config')({ redis }, 'load'));

  if (uCfg.error) {
    sendToBotChan({
      embeds: [
        new MessageEmbed()
          .setTitle('Reloading configuration failed: using defaults!')
          .setDescription(formatKVs(config.user)).setColor('RED')
      ]
    }, true);
    console.warn('Reloading user config failed', uCfg.error);
  } else {
    sendToBotChan({
      embeds: [
        new MessageEmbed().setTitle('User configuration').setDescription(formatKVs(uCfg)).setColor('AQUA')
      ]
    }, true);
  }

  sendToBotChan({
    embeds: [
      new MessageEmbed().setTitle(config.app.allowedSpeakersCommandPrefixCharacter)
        .setDescription('is the user command prefix character.').setColor('ORANGE')
    ]
  }, true);

  console.log('Discovered private messaging category:', config.discord.privMsgCategoryId, channelsById[config.discord.privMsgCategoryId]);
  if (!config.discord.privMsgCategoryId || !channelsById[config.discord.privMsgCategoryId]) {
    const potentials = Object.keys(categoriesByName).filter(x => x.match(/priv(?:ate)?\s*me?s(?:sa)?ge?s?/ig) || x === 'PMs');

    if (potentials && potentials.length) {
      const emb = new MessageEmbed()
        .setColor(config.app.stats.embedColors.irc.privMsg)
        .setTitle(`Discovered private message category "${potentials[0]}"`)
        .setDescription(`Category ID: ${categoriesByName[potentials[0]]}`)
        .addField('Channel inactivity removal time:', config.discord.privMsgChannelStalenessTimeMinutes + ' minutes');

      if (potentials.length > 1) {
        emb.addField('Also found the following potential categories', '...');
        potentials.slice(1).forEach((cName) => emb.addField(cName, categoriesByName[cName]));
      }

      await userCommands('config')({ redis: redisClient }, 'set', 'discord.privMsgCategoryId', categoriesByName[potentials[0]]);
      sendToBotChan(emb, true);
    }
  } else if (channelsById[config.discord.privMsgCategoryId]) {
    sendToBotChan(new MessageEmbed()
      .setColor(config.app.stats.embedColors.irc.privMsg)
      .setTitle(`Using private message category "${channelsById[config.discord.privMsgCategoryId].name}"`)
      .setDescription(`Category ID: ${config.discord.privMsgCategoryId}`)
      .addField('Channel inactivity removal time:', config.discord.privMsgChannelStalenessTimeMinutes + ' minutes'),
    true);
  } else {
    await userCommands('config')({ redis: redisClient }, 'set', 'discord.privMsgCategoryId', null);
    delete config.discord.privMsgCategoryId;
  }

  if (config.discord.privMsgCategoryId) {
    const toDel = Object.entries(channelsById).filter(([, { parent }]) => parent === config.discord.privMsgCategoryId);
    const realDel = await scopedRedisClient(async (aliveClient) => {
      const realDel = [];
      for (const [chanId, o] of toDel) {
        const network = await PrivmsgMappings.findNetworkForKey(chanId);
        if (!network) {
          console.warn(`No network found for PM channel ${chanId}! Removing.`);
          realDel.push([chanId, o]);
          continue;
        }

        const aKey = aliveKey(network, chanId);
        const pmChanTTL = await aliveClient.ttl(aKey);
        if (pmChanTTL === -1) {
          continue;
        }

        // only delete channels that have expired in Redis (assuming here that we've missed the keyspace notification for some reason)
        if (!(await aliveClient.get(aKey))) {
          realDel.push([chanId, o]);
        } else {
          const chanObj = await PrivmsgMappings.get(network, chanId);
          console.info(`PM channel for ${chanObj.target} on ${network} (${chanId}) still has ${fmtDuration(0, true, pmChanTTL * 1000)} to live.`);
        }
      }
      return realDel;
    });

    if (realDel.length) {
      const rmEmbed = new MessageEmbed()
        .setColor(config.app.stats.embedColors.irc.privMsg)
        .setTitle('Private Message channel cleanup')
        .setDescription('I removed the following stale private message channels:');

      for (const [chanId, { name }] of realDel) {
        console.log(`Removing old PM channel "${name}" ${chanId}`);
        rmEmbed.addField(name, chanId);
        await client.channels.cache.get(chanId).delete('discord.js startup');
      }

      await sendToBotChan(rmEmbed, true);
    }

    const privMsgExpiryListener = new Redis(config.redis.url);
    privMsgExpiryListener.on('pmessage', async (_chan, key, event) => {
      console.log('Expiry message', key, event);
      const [, prefix, type, trackingType, id, network] = key.split(':');

      if (!(await client.channels.cache.get(id))) {
        console.error(`Expiry message for unknown channel ID ${id}!`, prefix, type, trackingType, network);
        return;
      }

      if (prefix !== PREFIX) {
        stats.errors++;
        console.error(`bad prefix for keyspace notification! ${prefix}`, key, event);
        return;
      }

      if (event === 'expired') {
        if (type === 'pmchan') {
          if (trackingType === 'aliveness') {
            console.log(`PM channel ${id}:${network} expired! Removing...`);
            const chInfo = Object.entries(await PrivmsgMappings.forNetwork(network)).find(([chId]) => chId == id)?.[1]; // eslint-disable-line eqeqeq
            if (!chInfo || !chInfo.target || !channelsById[id]) {
              console.error('bad chinfo?!', key, event, chInfo, channelsById[id], await PrivmsgMappings.forNetwork(network));
              return;
            }

            if (channelsById[id].parent !== config.discord.privMsgCategoryId) {
              console.error('bad ch parent!?', key, event, channelsById[id].parent);
              return;
            }

            const toTime = Number(new Date());
            const queryArgs = [network, chInfo.target, `--from=${chInfo.created}`, `--to=${toTime}`, '--everything'];

            const rmEmbed = new MessageEmbed()
              .setColor(config.app.stats.embedColors.irc.privMsg)
              .setTitle('Private Message channel cleanup')
              .setDescription('I removed the following channel due to inactivity:')
              .addField(channelsById[id].name, 'Query logs for this session with:\n`' +
                config.app.allowedSpeakersCommandPrefixCharacter + `logs ${queryArgs.join(' ')}` + '`');

            const buttonId = [id, crypto.randomBytes(8).toString('hex')].join('-');
            const actRow = new MessageActionRow()
              .addComponents(
                new MessageButton().setCustomId(buttonId).setLabel('Query logs').setStyle('SUCCESS')
              );

            registerButtonHandler(buttonId, async (interaction) => {
              const logs = await userCommands('logs')({
                registerOneTimeHandler,
                removeOneTimeHandler,
                sendToBotChan,
                channelsById,
                network,
                categoriesByName,
                publish: eventHandlerContext.publish,
                argObj: {
                  _: queryArgs
                },
                options: {
                  from: chInfo.created,
                  to: toTime,
                  everything: true,
                  _: queryArgs.slice(0, 2)
                }
              }, ...queryArgs);

              interaction.update({ embeds: [rmEmbed], components: [] });
              sendToBotChan(logs);
            });

            client.channels.cache.get(config.irc.quitMsgChanId).send({
              embeds: [new MessageEmbed()
                .setColor(config.app.stats.embedColors.irc.privMsg)
                .setTitle('Private Message channel cleanup')
                .setDescription('I removed the following channel due to inactivity:')
                .addField(channelsById[id].name, 'Query logs for this session with the button below or:\n`' +
                  config.app.allowedSpeakersCommandPrefixCharacter + `logs ${queryArgs.join(' ')}` + '`')],
              components: [actRow]
            });

            client.channels.cache.get(id).delete('stale');
            PrivmsgMappings.remove(network, id);
          } else if (trackingType === 'removalWarning') {
            try {
              const mins = JSON.parse(await redisClient.get(aliveKey(network, id)));

              const rmWarnEmbed = new MessageEmbed()
                .setColor('#ff0000')
                .setTitle('Inactivity removal warning!')
                .setDescription(`This channel has been inactive for **${mins.humanReadable.alertMins}** ` +
                  `and will be removed in **${mins.humanReadable.remainMins}** if it remains inactive!\n\n` +
                  `Click the button below to reset this countdown to **${mins.humanReadable.origMins}**.`);

              const buttonId = [id, crypto.randomBytes(8).toString('hex')].join('-');
              const actRow = new MessageActionRow()
                .addComponents(
                  new MessageButton().setCustomId(buttonId).setLabel('Reset countdown').setStyle('SUCCESS')
                );

              const warnMsg = await client.channels.cache.get(id).send({ embeds: [rmWarnEmbed], components: [actRow] });

              registerButtonHandler(buttonId, async (interaction) => {
                await ticklePmChanExpiry(network, id);
                interaction.update({
                  embeds: [new MessageEmbed()
                    .setColor('#00ff00')
                    .setTitle('Countdown reset')
                    .setDescription('This message will self-destruct in 1 minute...')],
                  components: []
                });
                setTimeout(() => warnMsg.delete().catch(console.error), 60 * 1000);
              });
            } catch (err) {
              stats.errors++;
              console.error(`removalWarning KS notification threw (chan ${id})`, err);
            }
          }
        }
      } else {
        stats.errors++;
        console.error(`unknown keyspace event! key:${key} event: ${event}`);
      }
    });

    const ksKey = `__keyspace@${new URL(config.redis.url).pathname.replace('/', '')}*`;
    privMsgExpiryListener.psubscribe(ksKey);
    console.log(`Listening to expiry events on ${ksKey}`);
  }

  const mainSubClient = new Redis(config.redis.url);
  await mainSubClient.subscribe(PREFIX);

  const subscribedChans = {};
  const ircReady = {
    reject: (...a) => { throw new Error('ircReady not setup', a); },
    resolve: () => {}
  };

  ircReady.promise = new Promise((resolve, reject) => {
    const rr = (f, ...a) => {
      delete ircReady.reject;
      delete ircReady.resolve;
      f(...a);
    };

    ircReady.resolve = rr.bind(null, resolve);
    ircReady.reject = rr.bind(null, reject);
  });

  let ircHeartbeatListener;
  let ircHeartbeatHandle;
  const ircReadyHandler = async (readyRes) => {
    console.log('Got irc:ready!', readyRes);

    _isReconnect = readyRes && readyRes.isReconnect;

    if (readyRes.readyData) {
      const embed = new MessageEmbed()
        .setTitle('IRC is ready!')
        .setColor(config.app.stats.embedColors.irc.ready)
        .setDescription('Speaking as:')
        .addFields(...readyRes.readyData.map(x => ({ name: x.network, value: x.nickname, inline: true })))
        .setTimestamp();

      if (stats?.lastCalcs?.lagAsEmbedFields.length > 0) {
        embed.addField('Lag', '(in milliseconds)')
          .addFields(...stats.lastCalcs.lagAsEmbedFields);
      }

      sendToBotChan(embed, true);

      await scopedRedisClient(async (rClient) => {
        for (const { network } of readyRes.readyData) {
          const onConnectCmds = await userCommands('onConnect')({ redis: rClient }, network);

          for (const connectCmd of onConnectCmds) {
            console.log(await sendToBotChan(`Running connect command for \`${network}\`: \`${connectCmd}\``));
            await allowedSpeakerCommandHandler({ content: connectCmd }, null, { autoPrefixCurrentCommandChar: true });
          }
        }
      });
    } else {
      const embed = new MessageEmbed()
        .setColor(config.app.stats.embedColors.irc.ipcReconnect)
        .setTitle('Discord bot has reconnected to IRC')
        .addFields(
          { name: 'IRC uptime', value: stats.irc?.uptime, inline: true },
          { name: 'Redis uptime', value: stats.lastCalcs?.redisUptime, inline: true },
          { name: 'System uptime', value: stats.lastCalcs?.systemUptime, inline: true },
          { name: 'Bot reconnects', value: String(stats.irc?.discordReconnects), inline: true },
          { name: 'Memory available', value: stats.lastCalcs?.memoryAvailablePercent + '%', inline: true },
          { name: 'Load averages', value: stats.sinceLast?.loadavg.join(', '), inline: true },
          { name: 'Redis clients', value: stats.redis.clients.connected_clients.toString(), inline: true }
        )
        .setTimestamp();

      if (stats?.lastCalcs?.lagAsEmbedFields.length > 0) {
        embed.addField('Lag', '(in milliseconds)')
          .addFields(...stats.lastCalcs.lagAsEmbedFields);
      }

      sendToBotChan(embed, true);
    }

    if (!readyRes || !readyRes.isReconnect) {
      redisClient.publish(PREFIX, JSON.stringify({
        type: 'discord:channels',
        data: { categories, channelsById, categoriesByName }
      }));
    } else {
      console.log('Re-connected!');
    }

    const HB_FUDGE_FACTOR = 1.05;
    let ircLastHeartbeat = Number(new Date());
    ircHeartbeatListener = new Redis(config.redis.url);
    ircHeartbeatListener.on('message', (...a) => {
      const nowNum = Number(new Date());
      if (nowNum - ircLastHeartbeat > (config.irc.heartbeatFrequencyMs * HB_FUDGE_FACTOR)) {
        console.error('ircHeartbeatListener IRC heartbeat is late!', nowNum - ircLastHeartbeat);
      }
      ircLastHeartbeat = nowNum;
    });
    let numLates = 0;
    ircHeartbeatHandle = setInterval(() => {
      if (Number(new Date()) - ircLastHeartbeat > (config.irc.heartbeatFrequencyMs * HB_FUDGE_FACTOR)) {
        console.error('IRC heartbeat is late!', Number(new Date()) - ircLastHeartbeat);
        if (++numLates > 3) {
          const msg = `Looks like we lost IRC! Last hearbeat was ${Number(new Date()) - ircLastHeartbeat}ms ago (${numLates})`;
          console.error(msg);
          sendToBotChan(msg);
          clearInterval(ircHeartbeatHandle);
          ircHeartbeatListener.disconnect();
        }
      } else {
        numLates = 0;
      }
    }, config.irc.heartbeatFrequencyMs);
    ircHeartbeatListener.subscribe(PREFIX + ':heartbeats:irc');

    client.user.setStatus('online');
  };

  const runOneTimeHandlersMatchingDiscriminator = async (type, data, discrim, missingHandlerIsOk = false) => {
    console.debug('runOneTimeHandlersMatchingDiscriminator', type, discrim, data, oneTimeMsgHandlers);
    if (oneTimeMsgHandlers[type] && oneTimeMsgHandlers[type][discrim]) {
      try {
        for (const hfunc of oneTimeMsgHandlers[type][discrim]) {
          await hfunc(data);
        }

        delete oneTimeMsgHandlers[type][discrim];

        if (!Object.keys(oneTimeMsgHandlers[type]).length) {
          delete oneTimeMsgHandlers[type];
        }
      } catch (e) {
        console.error(`OTH for ${type}/${discrim} failed!`, e);
      }
    } else if (!missingHandlerIsOk) {
      console.error(`Expected one-time handler for type=${type} and discrim=${discrim}, but none were found! data=`, data);
    }
  };

  const mainContext = {
    pendingAliveChecks,
    allowedSpeakersAvatars,
    stats,
    runOneTimeHandlersMatchingDiscriminator,
    registerButtonHandler,
    sendToBotChan,
    ircReady,
    ircReadyHandler,
    client,
    channelsById,
    allowedSpeakersMentionString,
    subscribedChans,
    listenedToMutate,
    categories,
    categoriesByName,
    channelsByName,
    allowedSpeakerCommandHandler,
    isReconnect,
    setIsReconnect: (s) => (_isReconnect = s)
  };

  userCommands('scripts').bindContextForCronRuns(mainContext);
  mainSubClient.on('message', ipcMessageHandler.bind(null, mainContext));

  const userScriptsSubClient = new Redis(config.redis.url);
  await userScriptsSubClient.psubscribe('*');
  userScriptsSubClient.on('pmessage', async (_pattern, channel, msgJson) => {
    let msg = {
      type: channel,
      data: msgJson
    };

    try {
      msg = JSON.parse(msgJson);
    } catch (err) {
      console.error(`Failed to parse message data as json for user script channel=${channel}, msgJson:\n${msgJson}`);
      console.error(err);
    }

    await userCommands('scripts').runScriptsForEvent(mainContext, msg.type, msg.data, channel);
  });

  try {
    redisClient.publish(PREFIX, JSON.stringify({
      type: 'discord:startup',
      data: { categories, channelsById, categoriesByName }
    }));

    console.log('Waiting for irc:ready...');
    const readyRes = await ircReady.promise;
    _isReconnect = readyRes?.isReconnect;

    await userCommands('stats')({
      stats,
      options: {
        reload: true,
        silent: true
      },
      registerOneTimeHandler,
      removeOneTimeHandler,
      redis: redisClient,
      publish: (o) => redisClient.publish(PREFIX, JSON.stringify(o))
    });

    await ircReadyHandler(readyRes);

    const _persist = async () => {
      console.log(`Auto-persisting stats at ${config.app.statsSilentPersistFreqMins}-minute frequency`);
      await scopedRedisClient(async (redis) => {
        await userCommands('stats')({
          stats,
          options: {
            silent: true
          },
          registerOneTimeHandler,
          removeOneTimeHandler,
          redis,
          publish: (o) => redis.publish(PREFIX, JSON.stringify(o))
        });

        const { chatMsgsMpm, totMsgsMpm } = stats.lastCalcs;
        await redis.lpush(`${PREFIX}:mpmtrack`, JSON.stringify({
          chatMsgsMpm,
          totMsgsMpm,
          timestamp: Number(new Date())
        }));

        await plotMpmData(config.app.stats.mpmPlotTimeLimitHours, null, {
          alwaysLogScale: true
        });
      });
    };

    const silentStatsPersist = () => {
      if (config.app.statsSilentPersistFreqMins) {
        setTimeout(() => {
          _persist();
          silentStatsPersist();
        }, config.app.statsSilentPersistFreqMins * 60 * 1000);
      }
    };

    silentStatsPersist();
  } catch (err) {
    console.error('Ready handshake failed!', err);
  }
});

['error', 'debug', 'userUpdate', 'warn', 'presenceUpdate', 'shardError', 'rateLimit'].forEach((eName) => {
  client.on(eName, async (...a) => {
    console.debug({ event: eName }, ...a);
    if (eName === 'error' || eName === 'warn') {
      let msg = `Discord PROBLEM <${eName}>: ` + '```json\n' + JSON.stringify([...a], null, 2) + '\n```\n';

      if (eName === 'rateLimit') {
        const [_, rootPath, id] = a[0].path.split('/'); // eslint-disable-line no-unused-vars
        console.log(rootPath, 'RL!!', a[0], a[0].path, id, channelsById[id]);
        if (rootPath === 'webhooks') {
          const wh = await client.fetchWebhook(id);
          if (wh.channelId && channelsById[wh.channelId]) {
            msg += 'Channel:```json\n' + JSON.stringify(channelsById[wh.channelId], null, 2) + '\n```\n';
          }
          msg += 'Webhook:```json\n' + JSON.stringify(wh, null, 2) + '\n```\n';
        } else if (channelsById[id]) {
          msg += 'Channel:```json\n' + JSON.stringify(channelsById[id], null, 2) + '\n```\n';
        }
      }

      sendToBotChan(msg);
      console.error(msg);
      ++stats.errors;
    }
  });
});

async function main () {
  let { token } = config.discord;

  if (!token) {
    token = (await inq.prompt({
      type: 'password',
      name: 'token',
      message: `Enter token for bot with ID ${config.discord.botId}`
    })).token;
  }

  process.on('SIGINT', () => {
    console.log('Exiting...');
    clientOnSigint();
    process.on('exit', () => console.log('Done.'));
    setTimeout(process.exit, 2000);
  });

  await userCommands.init();

  registerContextMenus();
  client.login(token);
}

main();
