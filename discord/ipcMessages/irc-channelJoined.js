'use strict';

const config = require('config');
const Redis = require('ioredis');
const userCommands = require('../userCommands');
const {
  simpleEscapeForDiscord
} = require('../common');
const {
  replaceIrcEscapes,
  scopedRedisClient
} = require('../../util');
const { wrapUrls } = require('../../lib/wrapUrls');

const { AvatarGenerators, createAvatarName } = require('../avatarGenerators');

module.exports = async function (parsed, context) {
  const joined = parsed.data;
  const {
    allowedSpeakersAvatars,
    stats,
    sendToBotChan,
    client,
    channelsById,
    allowedSpeakersMentionString,
    subscribedChans,
    listenedToMutate,
    allowedSpeakerCommandHandler,
    isReconnect
  } = context;

  if (!joined.id || !joined.channel) {
    throw new Error('BAD JOINED SPEC', parsed);
  }

  const msgChan = client.channels.cache.get(joined.id);

  if (!msgChan) {
    console.debug(channelsById);
    throw new Error(`Bad Discord channel id ${joined.id}`, joined);
  }

  msgChan.__drcSend = (s) => {
    msgChan.send(wrapUrls(s))
      .catch((err) => console.error(`send on ${joined.channel} failed! "${err.message}"`, err.stack, parsed, JSON.stringify(err)));
  };

  const newClient = new Redis(config.redis.url);
  const ignoreClient = new Redis(config.redis.url);

  console.log(`Mapping channel ${joined.channel} to Discord ID ${joined.id}`);
  newClient.subscribe(joined.channel, (err, count) => {
    if (err) {
      console.error(`bad mapping ${joined.channel}`, joined);
      sendToBotChan(`bad mapping ${joined.channel}`);
      return;
    }

    // this is THE message handler for each mapped channel
    newClient.on('message', async (chan, msg) => {
      try {
        const parsed = JSON.parse(msg);
        const [type] = parsed.type.split(':');
        ++stats.messages.total;
        stats.messages.types[type] = (stats.messages.types[type] ?? 0) + 1;

        // ugh copy/pasted directly from above, need to refactor ALL OF THIS
        if (parsed.data && parsed.data.nick) {
          parsed.data.__orig_nick = parsed.data.nick;
          parsed.data.nick = simpleEscapeForDiscord(parsed.data.nick);
        }

        let avatar;
        if (parsed.type === 'irc:message') {
          const e = parsed.data;
          if (e.type === 'privmsg' || e.type === 'action') {
            // it's us (when enable_echomessage === true)
            if (config.irc.registered[e.__drcNetwork].user.nick === e.nick && allowedSpeakersAvatars.length) {
              avatar = allowedSpeakersAvatars[0];
            }

            const hiList = await userCommands('hilite')({ redis: ignoreClient }, e.__drcNetwork);
            const anmsNoBrackets = allowedSpeakersMentionString(['', '']);

            if (hiList && Array.isArray(hiList) && hiList.some(x => e.message.match(new RegExp(x, 'i')))) {
              if (config.user.markHilites) {
                for (const x of hiList) {
                  e.message = e.message.replace(new RegExp(`\b(${x})\b`, 'i'), '**_$1_**');
                }
              }

              e.message += ' ' + anmsNoBrackets;
            }

            const netNick = config.irc.registered[e.__drcNetwork].user.nick;
            let mentionIdx = e.message.search(new RegExp(netNick, 'i'));
            if (mentionIdx !== -1 && e.message.indexOf(anmsNoBrackets) === -1) {
              if (config.app.allowedSpeakersHighlightType === 'bracket') {
                mentionIdx += netNick.length;
                e.message = e.message.substring(0, mentionIdx) +
                  allowedSpeakersMentionString() +
                  e.message.substring(mentionIdx);
              } else if (config.app.allowedSpeakersHighlightType === 'replace') {
                const orig = e.message;
                e.message = e.message.replace(netNick, anmsNoBrackets);

                if (orig === e.message) {
                  e.message += ` ${anmsNoBrackets}`;
                }
              }
            }

            const ignoreList = await userCommands('ignore')({ redis: ignoreClient }, e.__drcNetwork);
            const mutedList = await userCommands('muted')({ redis: ignoreClient }, e.__drcNetwork);
            console.debug('ignoreList', e.nick, e.nick.replaceAll('\\', ''), ignoreList.includes(e.nick.replaceAll('\\', '')));
            console.debug('mutedList', mutedList, e.nick, e.nick.replaceAll('\\', ''), mutedList.includes(e.nick.replaceAll('\\', '')));

            let isMuted = false;
            if ((isMuted = (mutedList && Array.isArray(mutedList) && mutedList.includes(e.nick.replaceAll('\\', '')))) ||
              (ignoreList && Array.isArray(ignoreList) && ignoreList.includes(e.nick.replaceAll('\\', '')))) {
              console.debug(`MUTED=${isMuted} ${e.nick} ${context.key}`);
              stats.messages.ignored++;
              if (isMuted || config.user.squelchIgnored) {
                (await userCommands('ignore')({ redis: ignoreClient }, e.__drcNetwork, '_squelchMessage'))({ timestamp: new Date(), data: e });
                return;
              } else {
                e.message = '||' + e.message + '||';
              }
            }

            try {
              if (e.__drcNetwork === 'irc.libera.chat' && channelsById[joined.id].name.includes('videogames')) {
                const strippedContent = replaceIrcEscapes(e.message, true).trim();
                const vgProxiedMatch = strippedContent.match(/\[(.*?)\]\s+<[%@+]?(.*?)>\s+.*/);

                if (vgProxiedMatch?.length === 3) {
                  const [_, network, nick] = vgProxiedMatch; // eslint-disable-line no-unused-vars
                  e.__orig_nick = `${nick}/${network}`;
                  e.message = strippedContent.replace(/\[(.*?)\]\s+<[%@+]?(.*?)>/, '').trim();
                }
              }

              if (!avatar) {
                const fName = createAvatarName(e.__orig_nick, e.__drcNetwork);
                avatar = `https://robohash.org/${fName}.png`;
                try {
                  avatar = await AvatarGenerators[config.app.avatarGenerator]?.(fName);
                } catch (e) {
                  console.error('AvatarGenerator failed', e);
                }
              }

              const hooks = await msgChan.fetchWebhooks();
              let hook;

              if (hooks.size === 0) {
                hook = await msgChan.createWebhook(joined.id, { avatar });
                console.log('Created new webhook', joined.id, joined.channel, avatar);
              } else {
                hook = [...hooks.values()][0];

                if (hooks.size > 1) {
                  console.error('\n\nTOO MANY HOOKS ', joined.channel);
                  for (const die of [...hooks.values()].slice(1)) {
                    console.log('Killing', die);
                    die.delete();
                  }
                }
              }

              let content = wrapUrls(replaceIrcEscapes(e.message).trim());

              if (e.type === 'action') {
                content = `_${content}_`;
              }

              if (content.length === 0) {
                console.error('empty message!!', content, e.message);
              } else {
                console.debug('MSG send...', joined.channel, hook.id, '[' + content + ']');
                const msg = await hook.send({
                  avatarURL: avatar,
                  username: e.__orig_nick,
                  content
                });
                console.debug('MSG FFS', joined.channel, msg.content);
                stats.messages.channels[joined.channel] = (stats.messages.channels[joined.channel] ?? 0) + 1;
              }
            } catch (err) {
              console.error(`Failed to post message to ${joined.channel}/${joined.id}! "${err.message}`, err.stack);
              ++stats.error;
            }
          }
        }
      } catch (e) {
        const str = `bad msg on ${chan} (${joined.id})`;
        console.error(str, '\n\n', e, msg);
        sendToBotChan(`${str}\n\n${JSON.stringify(msg)}\n\n${e}`);
        ++stats.errors;
      }
    });
  });

  newClient.on('close', (...a) => {
    console.debug(`Redis client for ${joined.channel} / ${joined.id} closed!`, a);
  });

  subscribedChans[joined.id] = newClient;
  listenedToMutate.addOne();

  if (!isReconnect()) {
    const onJoinOpts = [parsed.data.__drcNetwork, `<#${parsed.data.id}>`];
    await scopedRedisClient(async (redis) => {
      const onJoinCtx = {
        redis,
        options: {
          _: onJoinOpts
        }
      };

      const onJoinList = await userCommands('onJoin')(onJoinCtx, ...onJoinOpts);
      console.debug(`Got onJoinList for ${onJoinOpts.join('_')}`, onJoinList);
      for (const onJoin of onJoinList) {
        console.log(await sendToBotChan(`Running join command for #${parsed.data.name} on \`${parsed.data.__drcNetwork}\`: \`${onJoin}\``));
        await allowedSpeakerCommandHandler({ content: onJoin }, null, { autoPrefixCurrentCommandChar: true });
      }
    });
  }

  if (!isReconnect() || !config.user.squelchReconnectChannelJoins) {
    sendToBotChan('Joined ' + `**${parsed.data.ircName}** (#${parsed.data.name}) on \`${parsed.data.__drcNetwork}\`, which has **${parsed.data.userCount}** users` +
      (parsed.data.operators && parsed.data.operators.length ? `\n**Operators**: ${parsed.data.operators.join(', ')}` : ''));
  }
};
