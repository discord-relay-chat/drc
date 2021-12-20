'use strict';

const inq = require('inquirer');
const config = require('config');
const { Client, Intents, MessageEmbed } = require('discord.js');
const Redis = require('ioredis');
const yargs = require('yargs');
const ipcMessageHandler = require('./discord/ipcMessage');
const { banner, setDefaultFont } = require('./discord/figletBanners');
const {
  PREFIX,
  VERSION,
  resolveNameForIRC,
  NetworkNotMatchedError
} = require('./util');

const userCommands = require('./discord/userCommands');
const { formatKVs } = require('./discord/common');

require('./logger')('discord');

const INTENTS = [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES, Intents.FLAGS.DIRECT_MESSAGES, Intents.FLAGS.GUILD_MESSAGE_TYPING];

const redisClient = new Redis(config.redis.url);
const client = new Client({ intents: INTENTS });
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

const channelMessageHandlers = {};
function registerChannelMessageHandler (channelId, handler) {
  channelMessageHandlers[channelId] = handler;
}

const allowedSpeakersMentionString = () => '[' + config.app.allowedSpeakers.map(x => `<@${x}>`).join(' ') + ']';

let sendToBotChan = (...a) => console.error('sendToBotChan not initialized!', ...a);

const ignoreSquelched = [];

const captureSpecs = {};

if (config.capture.enabled) {
  console.log(`Capture enabled: running cleanup loop on ${config.capture.cleanupLoopFreqSeconds} second frequency`);
  setInterval(() => {
    const nowNum = Number(new Date());
    Object.entries(captureSpecs).forEach(([network, netSpec]) => {
      Object.entries(netSpec).forEach(([channelId, chanSpec]) => {
        if (chanSpec && chanSpec.exp > (nowNum / 100) && nowNum > chanSpec.exp) {
          console.log(`Capture spec cleanup loop expiring ${network}:${channelId}`, chanSpec);
          sendToBotChan(`\`SYSTEM\` Expiring channel capture for <#${channelId}> on \`${network}\` having captured ${chanSpec.captured} messages.`);
          delete captureSpecs[network][channelId];
        }
      });
    });
  }, config.capture.cleanupLoopFreqSeconds * 1000);
}

setDefaultFont(config.figletBanners.font);

console.log(`${PREFIX} Discord controller starting...`);

const formatForAllowedSpeakerResponse = (s, raw = false) => (!raw ? `(*${new Date().toLocaleTimeString()}*) ${s}` : (s instanceof MessageEmbed ? { embeds: [s] } : s));

client.once('ready', async () => {
  console.log('Ready!');

  client.user.setStatus('idle');
  client.user.setActivity('the IRC daemon...', { type: 'LISTENING' });

  const [uName, uVer] = client.user.username.split(' ');
  const curVer = `v${VERSION}`;

  if (!uVer || uVer !== curVer) {
    console.warn('Setting RATE-LIMITED username!');
    client.user.setUsername(`${uName} ${curVer}`);
  }

  const onExit = async (s) => {
    sendToBotChan('\n```\n' + (await banner(s)) + '\n```\n');
    client.user.setStatus('invisible');
    client.user.setActivity('nothing! (I\'m offline!)', { type: 'LISTENING' });
  };

  process.on('exit', () => {
    console.log('beforeExit!');
    onExit('Bye!');
  });

  process.on('SIGINT', () => {
    console.log('Exiting...');
    onExit('Exit!');
    setInterval(process.exit, 2000);
  });

  const chanCache = client.channels.cache.values();

  // first pass to build channelsById & categories
  for (const chan of chanCache) {
    channelsById[chan.id] = { name: chan.name, parent: chan.parentId };

    if (!chan.parentId) {
      console.log(`Found category '${chan.name}' with ID ${chan.id}`);
      categories[chan.id] = {
        name: chan.name,
        channels: {}
      };

      categoriesByName[chan.name] = chan.id;
      channelsByName[chan.name] = {};
    }
  }

  console.debug('FIRST PASS RES', categories);

  // second pass to build channels in categories
  for (const chan of client.channels.cache.values()) {
    const { id, name, parentId } = chan;
    if (chan.parentId && categories[chan.parentId]) {
      console.log(`Found channel ${chan.name} (ID ${chan.id}) in category '${categories[chan.parentId].name}'`);
      categories[chan.parentId].channels[chan.id] = { id, name, parentId, parent: parentId };
      channelsByName[categories[chan.parentId].name][chan.name] = chan.id;
    }
  }

  console.log('READY STRUCTS');
  console.log('channelsById', channelsById);
  console.log('categoriesByName', categoriesByName);
  // console.debug('categories', channelsById)

  if (config.irc.quitMsgChanId) {
    sendToBotChan = async (s, raw = false) => {
      if (s.length > config.discord.maxMsgLength) {
        console.error('MSG TOO LARGE -- TRUNCATING!!\n', s);
        s = s.slice(0, config.discord.maxMsgLength - 50) + ' [TRUNCATED]';
      }

      let toSend;
      try {
        toSend = formatForAllowedSpeakerResponse(s, raw);
        await client.channels.cache.get(config.irc.quitMsgChanId).send(toSend);
      } catch (e) {
        console.error('sendToBotChan .send() threw!', e, s);
        ++stats.errors;

        setTimeout(() => sendToBotChan(`\`ERROR\` Discord send failure! "${e.message}"\n>>> ` + e.stack), 150);
      }

      return toSend;
    };
  }

  sendToBotChan('\n```\n' + (await banner('Hello!')) + '\n```\n\n');

  let allowedSpeakerCommandHandler = () => { throw new Error('allowedSpeakerCommandHandler not initialized! not configured?'); };

  if (config.app.allowedSpeakers.length) {
    allowedSpeakerCommandHandler = async (data, toChanId) => {
      const trimContent = data.content.replace(/^\s+/, '');
      if (trimContent[0] === '!') {
        const [command, ...args] = trimContent.slice(1).split(/\s+/);
        const fmtedCmdStr = '`' + `${command} ${args.join(' ')}` + '`';

        console.debug('USER CMD PARSED', command, fmtedCmdStr, args);
        const redis = new Redis(config.redis.url);

        try {
          const cmdFunc = userCommands(command);

          if (!cmdFunc) {
            console.warn('user comand not found! (silent to the user)', command, ...args);
            return;
          }

          const publish = async (publishObj) => redis.publish(PREFIX, JSON.stringify(publishObj));
          const argObj = yargs(args).help(false).exitProcess(false).argv;

          const createGuildChannel = async (channelName, channelOpts) =>
            client.guilds.cache.get(config.discord.guildId).channels.create(channelName, channelOpts);

          let localSender = sendToBotChan;

          if (toChanId) {
            localSender = async (msg, raw) => client.channels.cache.get(toChanId).send(formatForAllowedSpeakerResponse(msg, raw));
          }

          const result = await cmdFunc({
            stats,
            redis,
            publish, // TODO: replace all uses of `redis` with `publish` (and others if needed)
            sendToBotChan: localSender,
            argObj,
            options: argObj, // much better name! use this from now on...
            registerOneTimeHandler,
            createGuildChannel,
            registerChannelMessageHandler,
            discordAuthor: data.author,
            ignoreSquelched,
            captureSpecs,
            channelsById,
            categoriesByName,
            toChanId
          }, ...args);

          console.log(`Exec'ed user command ${command} with args [${args.join(', ')}] --> `, result);

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
        } catch (ucErr) {
          console.error('user command threw!\n\n', ucErr);

          if (ucErr instanceof NetworkNotMatchedError) {
            sendToBotChan(`Unable to find a matching network for "${ucErr.message}"`);
          } else {
            sendToBotChan(fmtedCmdStr + `threw an error! (${ucErr.name}):` +
              ' `' + ucErr.message + '`');
          }
        } finally {
          redis.disconnect();
        }
      }
    };

    client.on('messageCreate', async (data) => {
      if (!data.author || !config.app.allowedSpeakers.includes(data.author.id)) {
        if (data.author && data.author.id !== config.discord.botId) {
          sendToBotChan('`DISALLOWED SPEAKER` **' + data.author.username +
            '#' + data.author.discriminator + '**: ' + data.content);
          console.error('DISALLOWED SPEAKER', data.author, data.content);
        }
        return;
      }

      if (channelMessageHandlers[data.channelId]) {
        try {
          channelMessageHandlers[data.channelId](data);
        } catch (e) {
          console.error(`channel message handler for ${data.channelId} failed!`, data, e);
        }

        return;
      }

      let replyNick;
      if (data.type === 'REPLY') {
        const repliedMsgId = data.reference.messageId;
        console.debug('REPLYING TO MSG ID' + repliedMsgId + ' in channel ID ' + data.channelId);
        const chan = await client.channels.cache.get(data.channelId);
        const replyMsg = await chan.messages.cache.get(repliedMsgId);
        console.debug('REPLYING TO MSG ' + replyMsg);

        const replyNickMatch = replyMsg.content.matchAll(/<(?:\*\*)?(.*)(?:\*\*)>/g);

        if (replyNickMatch && !replyNickMatch.done) {
          const replyNickArr = replyNickMatch.next().value;

          if (replyNickArr && replyNickArr.length > 1) {
            replyNick = replyNickArr[1];
          }
        }
      }

      if (data.channelId === config.irc.quitMsgChanId || data.content.match(/^\s*!/)) {
        if (replyNick) {
          console.log(`Appending ${replyNick} to ${data.content} for user command in ${data.channelId}`);
          data.content = `${data.content} ${replyNick}`;
        }

        await allowedSpeakerCommandHandler(data, data.channelId !== config.irc.quitMsgChanId ? data.channelId : undefined);
        return;
      }

      const channel = channelsById[data.channelId];
      const network = categories[channel.parent];

      if (!channel || !network) {
        console.error('Bad channel or network!', channel, network);
        sendToBotChan('Bad channel or network!');
        ++stats.errors;
        return;
      }

      if (config.user.supressBotEmbeds) {
        await data.suppressEmbeds(true);
      }

      console.debug('messageCreate data param', data);

      if (data.attachments) {
        data.content += ' ' + [...data.attachments.entries()].map(([, att]) => att.proxyURL || att.attachment).join(' ');
      }

      console.debug('messageCreate chan', channel);

      if (replyNick) {
        console.log(`Replying to <${replyNick}> in ${data.channelId}`);
        data.content = `${replyNick}: ${data.content}`;
      }

      console.debug(`Emitting SAY with data.content: "${data.content}"`);

      let subType = 'say';
      if (data.content.indexOf('//me') === 0) {
        subType = 'action';
        data.content = data.content.replace('//me', '');
      }

      await redisClient.publish(PREFIX, JSON.stringify({
        type: 'irc:' + subType,
        data: {
          network: { name: network.name },
          channel: resolveNameForIRC(network.name, channel.name),
          message: data.content
        }
      }));

      if (config.user.deleteDiscordWithEchoMessageOn && config.irc.registered[network.name].user.enable_echomessage) {
        await data.delete();
      }
    });
  }

  client.on('channelCreate', async (data) => {
    const { name, parentId, id } = data;
    const parentCat = categories[parentId];

    console.debug('channelCreate', name, parentId, id, parentCat);

    if (!parentCat || !config.irc.registered[parentCat.name]) {
      console.warn('bad parent cat', parentId, parentCat, data);
      return;
    }

    registerOneTimeHandler('irc:responseJoinChannel', name, (data) => {
      console.debug('ONE TIME HANDLER for irc:responseJoinChannel ', name, id, data);
      if (data.name !== name || data.id !== id || data.parentId !== parentId) {
        console.warn('bad routing?!?!', name, id, parentId, data);
        return;
      }

      channelsById[id] = categories[data.parentId].channels[id] = { name, parent: parentId, ...data };
      channelsByName[categories[data.parentId].name][name] = id;
      listenedToMutate.addOne();
    });

    const c = new Redis(config.redis.url);

    await c.publish(PREFIX, JSON.stringify({
      type: 'discord:requestJoinChannel:irc',
      data: {
        name,
        id,
        parentId
      }
    }));

    c.disconnect();
  });

  client.on('channelDelete', async (data) => {
    const { name, parentId } = data;
    const parentCat = categories[parentId];
    const c = new Redis(config.redis.url);
    await c.publish(PREFIX, JSON.stringify({
      type: 'discord:deleteChannel',
      data: {
        name,
        network: parentCat.name
      }
    }));
    c.disconnect();
  });

  const cfgClient = new Redis(config.redis.url);
  const uCfg = await userCommands('config')({ redis: cfgClient }, 'load');
  cfgClient.disconnect();

  if (uCfg.error) {
    sendToBotChan(`\nReloading user configuration failed:\n\n**${uCfg.error.message}**\n`);
    sendToBotChan('\nUsing default user configuration:\n\n' + formatKVs(config.user));
    console.warn('Reloading user config failed', uCfg.error);
  } else {
    sendToBotChan('\nUser configuration:\n\n' + formatKVs(uCfg));
  }

  const mainSubClient = new Redis(config.redis.url);

  await mainSubClient.subscribe(PREFIX);

  console.log('Subed to Redis');
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

  const runOneTimeHandlersMatchingDiscriminator = async (type, data, discrim) => {
    console.debug('runOneTimeHandlersMatchingDiscriminator', type, discrim, data, oneTimeMsgHandlers);
    if (oneTimeMsgHandlers[type] && oneTimeMsgHandlers[type][discrim]) {
      try {
        for (const hfunc of oneTimeMsgHandlers[type][discrim]) {
          await hfunc(data);
        }
      } catch (e) {
        console.error(`OTH for ${type}/${discrim} failed!`, e);
      }

      delete oneTimeMsgHandlers[type][discrim];

      if (!Object.keys(oneTimeMsgHandlers[type]).length) {
        delete oneTimeMsgHandlers[type];
      }
    }
  };

  mainSubClient.on('message', ipcMessageHandler.bind(null, {
    stats,
    runOneTimeHandlersMatchingDiscriminator,
    sendToBotChan,
    ircReady,
    client,
    channelsById,
    captureSpecs,
    allowedSpeakersMentionString,
    subscribedChans,
    listenedToMutate,
    categories,
    categoriesByName,
    channelsByName,
    allowedSpeakerCommandHandler,
    isReconnect
  }));

  try {
    redisClient.publish(PREFIX, JSON.stringify({
      type: 'discord:startup',
      data: { categories, channelsById, categoriesByName }
    }));

    console.log('Waiting for irc:ready...');
    sendToBotChan('Waiting for IRC bridge...');
    const readyRes = await ircReady.promise;
    console.log('Got irc:ready!', readyRes);

    _isReconnect = readyRes && readyRes.isReconnect;

    await userCommands('stats')({
      stats,
      options: {
        reload: true,
        silent: true
      },
      registerOneTimeHandler,
      redis: redisClient,
      publish: (o) => redisClient.publish(PREFIX, JSON.stringify(o))
    });

    const _persist = async () => {
      console.log(`Auto-persisting stats at ${config.app.statsSilentPersistFreqMins}-minute frequency`);
      const redis = new Redis(config.redis.url);
      await userCommands('stats')({
        stats,
        options: {
          silent: true
        },
        registerOneTimeHandler,
        redis,
        publish: (o) => redis.publish(PREFIX, JSON.stringify(o))
      });
      redis.disconnect();
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

    if (readyRes.readyData) {
      const embed = new MessageEmbed()
        .setTitle('IRC is ready!')
        .setColor(config.app.stats.embedColors.irc.ready)
        .setDescription('Speaking as:')
        .addFields(...readyRes.readyData.map(x => ({ name: x.network, value: x.nickname, inline: true })))
        .addField('Lag', '(in milliseconds)')
        .addFields(...stats.lastCalcs.lagAsEmbedFields)
        .setTimestamp();
      sendToBotChan(embed, true);

      const rClient = new Redis(config.redis.url);
      for (const { network } of readyRes.readyData) {
        const onConnectCmds = await userCommands('onConnect')({ redis: rClient }, network);

        for (const connectCmd of onConnectCmds) {
          console.log(await sendToBotChan(`Running connect command for \`${network}\`: \`${connectCmd}\``));
          await allowedSpeakerCommandHandler({ content: connectCmd });
        }
      }
      rClient.disconnect();
    } else {
      sendToBotChan(new MessageEmbed()
        .setColor(config.app.stats.embedColors.irc.ipcReconnect)
        .setTitle('IRC is reconnected!')
        .addFields(
          { name: 'IRC uptime', value: stats.irc.uptime, inline: true },
          { name: 'Redis uptime', value: stats.lastCalcs.redisUptime, inline: true },
          { name: 'System uptime', value: stats.lastCalcs.systemUptime, inline: true },
          { name: 'Memory available', value: stats.lastCalcs.memoryAvailablePercent + '%', inline: true },
          { name: 'Load averages', value: stats.sinceLast.loadavg.join(', '), inline: true },
          { name: 'Redis clients', value: stats.redis.clients.connected_clients.toString(), inline: true }
        )
        .addField('Lag', '(in milliseconds)')
        .addFields(...stats.lastCalcs.lagAsEmbedFields)
        .setTimestamp(),
      true);
    }

    if (!readyRes || !readyRes.isReconnect) {
      redisClient.publish(PREFIX, JSON.stringify({
        type: 'discord:channels',
        data: { categories, channelsById, categoriesByName }
      }));
    } else {
      console.log('Re-connected!');
      sendToBotChan('Re-connected!');
    }

    client.user.setStatus('online');
  } catch (err) {
    console.error('Ready handshake failed!', err);
  }
});

['interactionCreate', 'error', 'userUpdate', 'warn', 'presenceUpdate', 'shardError'].forEach((eName) => {
  client.on(eName, (...a) => {
    console.debug({ event: eName }, ...a);
    if (eName === 'error' || eName === 'warn') {
      const msg = `DJS PROBLEM <${eName}>: ${JSON.stringify([...a], null, 2)}`;
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

  client.login(token);
}

main();
