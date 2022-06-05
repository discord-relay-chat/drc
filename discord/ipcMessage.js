'use strict';

const config = require('config');
const userCommands = require('./userCommands');
const {
  simpleEscapeForDiscord
} = require('./common');
const {
  resolveNameForDiscord,
  replaceIrcEscapes,
  scopedRedisClient
} = require('../util');
const { MessageEmbed } = require('discord.js');
const numerics = require('../irc/numerics');

const ipcMessageHandlers = require('./ipcMessages');
console.log(`Loaded ${Object.keys(ipcMessageHandlers).length} Discord IPC message handlers: ` +
  `${Object.keys(ipcMessageHandlers).filter(x => x.indexOf('_') !== 0).join(', ')}`);

const serialQueue = [];
let serialLock = false;
setInterval(() => {
  if (serialQueue.length) {
    if (serialLock) {
      return;
    }

    serialLock = true;
    serialQueue.shift()()
      .then((...a) => a)
      .catch((err) => {
        console.error('serialized op failed', err);
      }).finally(() => {
        serialLock = false;
      });
  }
}, 10);

const serialize = (op) => serialQueue.push(op);

let isIrcConnected = false;

module.exports = async (context, _channel, msg) => {
  const {
    stats,
    runOneTimeHandlersMatchingDiscriminator,
    sendToBotChan,
    ircReady,
    ircReadyHandler,
    client,
    categories,
    categoriesByName,
    channelsByName,
    listenedToMutate,
    subscribedChans,
    setIsReconnect
  } = context;

  ++stats.messages.total;

  try {
    const parsed = JSON.parse(msg);
    const [type, subType, subSubType] = parsed.type.split(':');
    ++stats.messages.total;
    stats.messages.types[type] = (stats.messages.types[type] ?? 0) + 1;

    if (parsed.data && typeof parsed.data === 'object') {
      parsed.data._orig = {};
      ['nick', 'kicked', 'ident', 'hostname'].forEach((i) => {
        if (parsed.data[i]) {
          parsed.data._orig[i] = parsed.data[i];
          parsed.data[i] = simpleEscapeForDiscord(parsed.data[i]);
        }
      });
    }

    const runOneTimeHandlers = runOneTimeHandlersMatchingDiscriminator.bind(this, parsed.type, parsed.data);

    const [c2pfx, subroute] = parsed.type.split('::');
    if (c2pfx === '__c2' && subroute) {
      console.log('C2 MSG', subroute);
      return await runOneTimeHandlers(parsed.data);
    }

    // console.log('RESOLVE!?', parsed.type, !!ipcMessageHandlers[parsed.type], Object.keys(ipcMessageHandlers));
    if (ipcMessageHandlers[parsed.type]) {
      // 'return await' to ensure we catch anything here rather than bubbling up
      return await ipcMessageHandlers[parsed.type](parsed, { runOneTimeHandlers, serialize, ...context });
    }

    await (async function () {
      if (type === 'http' && subType === 'get-req' && subSubType) {
        runOneTimeHandlers(subSubType);
      } else if (type === 'irc' && subType === 'responseJoinChannel') {
        runOneTimeHandlers(parsed.data.name);
      } else if (type === 'discord' && subType === 'shodan' && subSubType === 'info') {
        sendToBotChan('`SHODAN INFO`\n```json\n' + JSON.stringify(parsed.data, null, 2) + '\n```\n');
      } else if (type === 'irc' && subType === 'responsePs') {
        sendToBotChan('\n\n' + parsed.data.map((psObj) => `\`${psObj.pid}\`\t\`${psObj.started}\`\t\`${psObj.args.join(' ')}\``).join('\n\t'));
      } else if (type === 'irc' && subType === 'ready') {
        isIrcConnected = true;
        console.debug('IRC is ready!', parsed.data);
        (ircReady.resolve || ircReadyHandler)(parsed.data);
      } else if (parsed.type === 'irc:joined') {
        const embed = new MessageEmbed()
          .setColor(config.app.stats.embedColors.irc.networkJoined)
          .setTitle(`Fully joined network \`${parsed.data.network}\``)
          .setDescription('Listening to ' + `**${parsed.data.channels.length}** channels`)
          .setTimestamp();
        sendToBotChan(embed, true);
      } else if (parsed.type === 'irc:quit') {
        const e = parsed.data;
        stats.sinceLast.quits.push(e.nick.replace(/[^a-zA-Z0-9]/g, ''));

        if (config.user.showQuits) {
          sendToBotChan(`\`QUIT\` **${parsed.data.nick}** <_${parsed.data.ident}@${parsed.data.hostname}_> quit: "${replaceIrcEscapes(parsed.data.message)}"`);
        }
      } else if (parsed.type === 'irc:exit' || parsed.type === 'irc:socket_close' || parsed.type === 'irc:reconnecting') {
        const { __drcNetwork } = parsed.data;
        if (isIrcConnected) {
          sendToBotChan(`Lost IRC connection to **${__drcNetwork}** at **${new Date()}**! (\`${parsed.type}\`)`);
        }

        if (parsed.type === 'irc:reconnecting') {
          const { attempt, max_retries, wait } = parsed.data; // eslint-disable-line camelcase
          setIsReconnect(true);
          sendToBotChan(`Reconnect attempt ${attempt} of ${max_retries}, trying again in ${Math.round(Number(wait / 1000))} seconds...`); // eslint-disable-line camelcase
        }

        if (!isIrcConnected) {
          return;
        }

        isIrcConnected = false;

        for (const [chanId, client] of Object.entries(subscribedChans)) {
          await client.disconnect();
          delete subscribedChans[chanId];
          console.debug(`closed ${chanId} redis client`);
        }
      } else if (type === 'irc' && subType === 'nick') {
        if (config.user.showNickChanges) {
          sendToBotChan(`**${parsed.data.nick}** <_${parsed.data.ident}@${parsed.data.hostname}_> changed nickname to **${parsed.data.new_nick}** on \`${parsed.data.__drcNetwork}\``);
        }
      } else if (type === 'irc' && subType === 'motd') {
        sendToBotChan('Message Of The Day (MOTD) for network `' + parsed.data.__drcNetwork + '`\n```\n' + parsed.data.motd + '\n```\n');
      } else if (type === 'irc' && subType === 'numeric') {
        sendToBotChan('`IRC:' + subSubType + '` on ' + `\`${parsed.data.hostname || parsed.data.__drcNetwork}\`:\n>>> ${parsed.data.parsed ?? JSON.stringify(parsed.data.params)}`);
      } else if (type === 'irc' &&
        (subType === 'topic' || subType === 'join' || subType === 'part' || subType === 'kick')) {
        const discName = resolveNameForDiscord(parsed.data.__drcNetwork, parsed.data.channel);
        const discId = channelsByName[parsed.data.__drcNetwork][discName];
        const chanSpec = categories[categoriesByName[parsed.data.__drcNetwork]].channels[channelsByName[parsed.data.__drcNetwork][discName]];

        if (subType === 'join' || subType === 'part') {
          const opts = [parsed.data.__drcNetwork, `<#${discId}>`];
          const showPerChan = await scopedRedisClient(async (redis) => userCommands('showPerChan')({
            redis,
            options: {
              _: opts
            }
          }, ...opts));

          if (showPerChan?.indexOf(subType) === -1) {
            if ((subType === 'join' && !config.user.showJoins) || (subType === 'part' && !config.user.showParts)) {
              return;
            }
          }
        }

        if (!chanSpec) {
          console.debug(parsed, discName, chanSpec);
          console.debug('categories', categories);
          console.debug('channelsByName', channelsByName);
          console.debug('categoriesByName', categoriesByName);
          console.debug('CHAN ID', channelsByName[parsed.data.__drcNetwork][discName]);
          console.debug('CAT ID', categoriesByName[parsed.data.__drcNetwork]);
          throw new Error(`Bad chanSpec for TOPIC/PART/KICK/JOIN message DN:${discName} CS:${JSON.stringify(chanSpec)}`);
        }

        const msgChan = client.channels.cache.get(chanSpec.id);

        if (parsed.data.message) {
          parsed.data.message = replaceIrcEscapes(parsed.data.message);
        }

        if (msgChan) {
          if (subType === 'part' || subType === 'join') {
            let sender = sendToBotChan;
            if ((subType === 'join' ? !config.user.joinsToBotChannel : true)) {
              sender = (msgChan.__drcSend || msgChan.send).bind(msgChan);
            }

            sender(`**${parsed.data.nick}** <_${parsed.data.ident}@${parsed.data.hostname}_> ${subType}ed${subType !== 'join'
              ? (config.user.joinsToBotChannel ? ` #${parsed.data.channel}: "${parsed.data.message}"` : ': "' + parsed.data.message + '"')
  : ''}`);
          } else if (subType === 'kick') {
            const { kicked, channel, ident, hostname, message, __drcNetwork } = parsed.data;
            await scopedRedisClient(async (redis, prefix) => {
              const zsetKey = `${prefix}:kicks:${__drcNetwork}`;
              await redis.zincrby(zsetKey + ':kickee', 1, kicked);
              await redis.zincrby(zsetKey + ':kicker', 1, `${ident}@${hostname}`);
              await redis.zincrby(zsetKey + ':chans', 1, channel);
              await redis.zincrby(zsetKey + ':reasons', 1, message);
            });
          } else if (subType === 'topic' && parsed.data.topic) {
            msgChan.setTopic(parsed.data.topic);
          }
        } else {
          // skip our own parts, since the channel will necessarily have _already_ been deleted!
          if (config.irc.registered[parsed.data.__drcNetwork].user.nick !== (parsed.data._orig.nick ?? parsed.data.nick)) {
            if (subType === 'part') {
              sendToBotChan(`**${parsed.data.nick}** <_${parsed.data.ident}@${parsed.data.hostname}_> ${parsed.data.channel} "${parsed.data.message}"`);
            }

            throw new Error(subType + '-- chan lookup failed', discName, chanSpec, parsed);
          } else {
            listenedToMutate.subOne();
          }
        }
      } else if (type === 'irc') {
        if (['say', 'join', 'pong', 'tagmsg', 'action', 'whois', 'account'].includes(subType) || (subType === 'responseSay' && !parsed.data)) {
          return;
        }

        if (subType === 'part' && !config.user.showParts) {
          return;
        }

        if (subType === 'unknown_command' && parsed.data.params &&
          parsed.data.params[0] === config.irc.registered[parsed.data.__drcNetwork].user.nick) {
          const numCmd = Number(parsed.data.command);
          if (numerics[numCmd]) {
            const numSpec = numerics[numCmd];
            sendToBotChan('`IRC:' + numSpec.name + '` on ' + `\`${parsed.data.hostname || parsed.data.__drcNetwork}\`:\n>>> ${numSpec.parse(parsed.data)}`);
          } else {
            sendToBotChan('`IRC:UNK` on ' + `\`${parsed.data.hostname || parsed.data.__drcNetwork}\` (_command number ${parsed.data.command}_):` + '\n```\n' + parsed.data.params.slice(1).join('\n') + '\n```');
          }
          return;
        }

        const msgStr = '**UNHANDLED** `' + type.toUpperCase() + ':' + subType.toUpperCase() + '` on `' +
          (parsed.data.hostname || parsed.data.__drcNetwork) + '`: ```json\n' + JSON.stringify(parsed.data, null, 2) + '\n```\n';
        console.warn(msgStr);
        sendToBotChan(msgStr);
      } else {
        const allowUnhandled = [
          'discord:requestStats:irc',
          'discord:createGetEndpoint',
          'discord:startup',
          'http:get-res:',
          'discord:requestWhois:irc',
          'discord:requestUserList:irc'
        ];

        if (allowUnhandled.some((x) => parsed.type.indexOf(x) === 0)) {
          return;
        }

        console.warn(`Unhandled message type=${parsed.type}:`, parsed);
      }
    })();
  } catch (e) {
    console.error('INTERNAL ERROR', e, msg);
    sendToBotChan('**INTERNAL ERROR**\n```\n' + `\n\n${e}\n\n${e.stack}\n\n${JSON.stringify(msg)}` + '\n```\n');
    ++stats.errors;

    if (ircReady.reject) {
      ircReady.reject(e);
    }
  }
};
