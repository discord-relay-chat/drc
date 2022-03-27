'use strict';

const config = require('config');
const Redis = require('ioredis');
const userCommands = require('../userCommands');
const {
  persistMessage,
  simpleEscapeForDiscord
} = require('../common');
const {
  PREFIX,
  replaceIrcEscapes,
  scopedRedisClient
} = require('../../util');

module.exports = async function (parsed, context) {
  const joined = parsed.data;
  const {
    stats,
    sendToBotChan,
    client,
    channelsById,
    captureSpecs,
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

  msgChan.__drcSend = (s, raw = false) => {
    msgChan.send(
      raw ? s : (config.user.timestampMessages ? '`' + new Date().toLocaleTimeString() + '` ' : '') + s
    )
      .catch((err) => console.error(`send on ${joined.channel} failed! "${err.message}"`, err.stack, parsed, JSON.stringify(err)));
  };

  const newClient = new Redis(config.redis.url);
  const ignoreClient = new Redis(config.redis.url);

  console.log(`Mapping channel ${joined.channel} to Discord ID ${joined.id}`);
  newClient.subscribe(joined.channel, (err, count) => {
    if (err) {
      throw new Error(`bad mapping ${joined.channel}`, joined);
    }

    newClient.on('message', async (chan, msg) => {
      // console.debug(chan, 'msg!', msg)
      try {
        const parsed = JSON.parse(msg);
        const [type] = parsed.type.split(':');
        ++stats.messages.total;
        stats.messages.types[type] = (stats.messages.types[type] ?? 0) + 1;

        // ugh copy/pasted directly from above, need to refactor ALL OF THIS
        if (parsed.data && parsed.data.nick) {
          parsed.data.nick = simpleEscapeForDiscord(parsed.data.nick);
        }

        if (parsed.type === 'irc:message') {
          const e = parsed.data;
          if (e.type === 'privmsg' || e.type === 'action') {
            let eHead = config.app.render.message.normal.head;
            let eFoot = config.app.render.message.normal.foot;
            let eStyle = config.app.render.message.normal.style;

            if (e.type === 'action') {
              eHead = config.app.render.message.action.head;
              eFoot = config.app.render.message.action.foot;
              eStyle = config.app.render.message.action.style;
            }

            // it's us (when enable_echomessage === true)
            if (config.irc.registered[e.__drcNetwork].user.nick === e.nick) {
              eStyle = config.app.render.message.self.style;
            }

            const persistMsgWithAutoCapture = async (type) => {
              const msgId = await persistMessage(PREFIX, 'mentions', e.__drcNetwork, { timestamp: new Date(), data: e });
              console.debug('Persisted', type, msgId);
              ++stats.messages.mentions;

              if (config.user.autoCaptureOnMention) {
                const options = {
                  _: [e.__drcNetwork, `<#${joined.id}>`],
                  duration: config.capture.autoCaptureWindowMins
                };

                console.debug('AUTO CAPTURING', options);
                await userCommands('capture')({
                  options,
                  captureSpecs,
                  sendToBotChan,
                  overridePrefixMsg: `On ${type}, auto-capturing`,
                  redis: ignoreClient
                }, ...options._);
              }
            };

            const hiList = await userCommands('hilite')({ redis: ignoreClient }, e.__drcNetwork);

            if (hiList && Array.isArray(hiList) && hiList.some(x => e.message.match(new RegExp(`\\b(${x})\\b`, 'i')))) {
              if (config.user.markHilites) {
                for (const x of hiList) {
                  e.message = e.message.replace(new RegExp(`\\b(${x})\\b`, 'i'), '**_$1_**');
                }
              }

              e.message += ' ' + allowedSpeakersMentionString();
              await persistMsgWithAutoCapture('hilite');
            }

            const netNick = config.irc.registered[e.__drcNetwork].user.nick;
            let mentionIdx = e.message.search(new RegExp(netNick, 'i'));
            if (mentionIdx !== -1) {
              mentionIdx += netNick.length;
              e.message = e.message.substring(0, mentionIdx) +
                allowedSpeakersMentionString() +
                e.message.substring(mentionIdx);

              await persistMsgWithAutoCapture('mention');
            }

            const ignoreList = await userCommands('ignore')({ redis: ignoreClient }, e.__drcNetwork);

            if (ignoreList && Array.isArray(ignoreList) && ignoreList.includes(e.nick.replace('\\', ''))) {
              stats.messages.ignored++;
              if (config.user.squelchIgnored) {
                (await userCommands('ignore')({ redis: ignoreClient }, e.__drcNetwork, '_squelchMessage'))({ timestamp: new Date(), data: e });
                return;
              } else {
                e.message = '||' + e.message + '||';
              }
            }

            try {
              msgChan.__drcSend(`${eHead}${eStyle}${e.nick}${eStyle}${eFoot} ${replaceIrcEscapes(e.message).trim()}`);
              stats.messages.channels[joined.channel] = (stats.messages.channels[joined.channel] ?? 0) + 1;
            } catch (err) {
              console.error(`Failed to post message to ${joined.channel}/${joined.id}! "${err.message}`, err.stack);
              ++stats.error;
            }

            if (captureSpecs[e.__drcNetwork]) {
              const now = new Date();
              const nowNum = Number(now);

              if (captureSpecs[e.__drcNetwork][joined.id]) {
                console.debug('CAP SPEC', captureSpecs[e.__drcNetwork][joined.id]);
                const ele = captureSpecs[e.__drcNetwork][joined.id];
                const persist = () => {
                  ele.captured++;
                  console.debug('PERSIST capture', joined.id, joined.channel, e.__drcNetwork);
                  persistMessage(PREFIX, ['capture', joined.id].join(':'), e.__drcNetwork, {
                    timestamp: now,
                    data: e
                  });
                };

                const expire = () => {
                  console.log(`Expiring capture spec ${e.__drcNetwork}:${joined.id}`);
                  delete captureSpecs[e.__drcNetwork][joined.id];
                  sendToBotChan(`\`SYSTEM\` Expiring channel capture for <#${joined.id}> on \`${e.__drcNetwork}\` having captured ${ele.captured} messages.`);
                };

                if (ele.exp > (nowNum / 100)) {
                  if (nowNum > ele.exp) {
                    expire();
                  } else {
                    persist();
                  }
                } else {
                  ele.exp--;
                  persist();
                  if (!ele.exp) {
                    expire();
                  }
                }
              }
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
        await allowedSpeakerCommandHandler({ content: onJoin });
      }
    });
  }

  if (!isReconnect() || !config.user.squelchReconnectChannelJoins) {
    sendToBotChan('Joined ' + `**${parsed.data.ircName}** (#${parsed.data.name}) on \`${parsed.data.__drcNetwork}\`, which has **${parsed.data.userCount}** users` +
      (parsed.data.operators && parsed.data.operators.length ? `\n**Operators**: ${parsed.data.operators.join(', ')}` : ''));
  }
};
