'use strict';

const config = require('config');
const Redis = require('ioredis');
const userCommands = require('./userCommands');
const { formatKVs, persistMessage } = require('./common');
const {
  PREFIX,
  resolveNameForDiscord,
  fmtDuration
} = require('../util');
const { MessageEmbed } = require('discord.js');
const numerics = require('../irc/numerics');

module.exports = async (context, channel, msg) => {
  const {
    stats,
    runOneTimeHandlersMatchingDiscriminator,
    sendToBotChan,
    ircReady,
    client,
    channelsById,
    captureSpecs,
    allowedSpeakersMentionString,
    subscribedChans,
    categories,
    categoriesByName,
    channelsByName,
    listenedToMutate,
    allowedSpeakerCommandHandler,
    isReconnect
  } = context;

  // console.debug(channel, '<Redis msg>', msg)
  ++stats.messages.total;

  try {
    const parsed = JSON.parse(msg);
    const [type, subType, subSubType] = parsed.type.split(':');
    ++stats.messages.total;
    stats.messages.types[type] = (stats.messages.types[type] ?? 0) + 1;

    const runOneTimeHandlers = runOneTimeHandlersMatchingDiscriminator.bind(this, parsed.type, parsed.data);

    if (type === 'http' && subType === 'get-req' && subSubType) {
      runOneTimeHandlers(subSubType);
    } else if (type === 'irc' && subType === 'responseJoinChannel') {
      runOneTimeHandlers(parsed.data.name);
    } else if (type === 'discord' && subType === 'shodan' && subSubType === 'info') {
      sendToBotChan('`SHODAN INFO`\n```json\n' + JSON.stringify(parsed.data, null, 2) + '\n```\n');
    } else if (type === 'discord' && subType === 'shodan' && subSubType === 'host') {
      const hostObj = parsed.data;

      if (hostObj.error) {
        sendToBotChan(
          '`HOST LOOKUP` FAILED! **' + hostObj.error.message.replace('got.get : ', '') + '**'
        );
      } else {
        sendToBotChan(
          '`HOST LOOKUP` for ' + `**${hostObj.ip_str}**:\n\n` +
          `**Owner**:\n\t${hostObj.org} (hosted by ${hostObj.isp}) in ${hostObj.city}, ${hostObj.region_code}, ${hostObj.country_code}\n\n` +
          '**Open Services**:\n' + hostObj.data.sort((a, b) => a.port - b.port).map((svc) => (
            `\t**${svc.port} (${svc.transport})** _${svc.product}_`
          )).join('\n')
        );
      }
    } else if (type === 'irc' && subType === 'responsePs') {
      sendToBotChan('`IRC:PS`: \n\n\t' + parsed.data.map((psObj) => `\`${psObj.pid}\`\t\`${psObj.started}\`\t\`${psObj.args.join(' ')}\``).join('\n\t'));
    } else if (type === 'irc' && subType === 'responseStats') {
      if (!parsed.stats) {
        throw new Error('expecting stats but none!');
      }

      parsed.stats.uptime = fmtDuration(new Date(parsed.stats.upSince));
      await runOneTimeHandlersMatchingDiscriminator(parsed.type, parsed.stats, 'stats');
    } else if (type === 'irc' && subType === 'ready') {
      console.debug('IRC is ready!', parsed.data);
      ircReady.resolve(parsed.data);
    } else if (parsed.type === 'irc:channelJoined') {
      const joined = parsed.data;

      if (!joined.id || !joined.channel) {
        throw new Error('BAD JOINED SPEC', parsed);
      }

      const msgChan = client.channels.cache.get(joined.id);

      if (!msgChan) {
        console.debug(channelsById);
        throw new Error(`Bad Discord channel id ${joined.id}`, joined);
      }

      msgChan.__s = msgChan.send;
      msgChan.send = (s) => msgChan.__s('`[' + new Date().toLocaleTimeString() + ']` ' + s);

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

            if (parsed.type === 'irc:message') {
              const e = parsed.data;
              if (e.type === 'privmsg' || e.type === 'action') {
                let eHead = '<';
                let eFoot = '>';
                let eStyle = '**';

                if (e.type === 'action') {
                  eHead = '* ';
                  eFoot = '';
                }

                // it's us (when enable_echomessage === true)
                if (config.irc.registered[e.__drcNetwork].user.nick === e.nick) {
                  eStyle = '_';
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
                let mentionIdx = e.message.indexOf(netNick);
                if (mentionIdx !== -1) {
                  mentionIdx += netNick.length;
                  e.message = e.message.substring(0, mentionIdx) +
                    allowedSpeakersMentionString() +
                    e.message.substring(mentionIdx);

                  await persistMsgWithAutoCapture('mention');
                }

                const ignoreList = await userCommands('ignore')({ redis: ignoreClient }, e.__drcNetwork);

                if (ignoreList && Array.isArray(ignoreList) && ignoreList.includes(e.nick)) {
                  stats.messages.ignored++;
                  if (config.user.squelchIgnored) {
                    (await userCommands('ignore')({ redis: ignoreClient }, e.__drcNetwork, '_squelchMessage'))({ timestamp: new Date(), data: e });
                    return;
                  } else {
                    e.message = '||' + e.message + '||';
                  }
                }

                msgChan.send(`${eHead}${eStyle}${e.nick}${eStyle}${eFoot} ${e.message}`);
                stats.messages.channels[joined.channel] = (stats.messages.channels[joined.channel] ?? 0) + 1;

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

      sendToBotChan('`IRC:JOINED-CHANNEL` ' + `**${parsed.data.ircName}** (#${parsed.data.name}) on \`${parsed.data.__drcNetwork}\` has **${parsed.data.userCount}** users` +
        (parsed.data.operators && parsed.data.operators.length ? `\n**Operators**: ${parsed.data.operators.join(', ')}` : ''));

      if (!isReconnect()) {
        const onJoinOpts = [parsed.data.__drcNetwork, `<#${parsed.data.id}>`];
        const onJoinCtx = {
          redis: new Redis(config.redis.url),
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

        onJoinCtx.redis.disconnect();
      }
    } else if (parsed.type === 'irc:joined') {
      // sendToBotChan('`IRC:JOINED` network ' + parsed.data.network + '\n\n' + ` * Listening to ${parsed.data.channels.length} channels.\n`)
    } else if (parsed.type === 'irc:quit') {
      const e = parsed.data;
      stats.sinceLast.quits.push(e.nick.replace(/[^a-zA-Z0-9]/g, ''));

      if (config.user.showQuits) {
        sendToBotChan(`\`QUIT\` **${parsed.data.nick}** <_${parsed.data.ident}@${parsed.data.hostname}_> quit: "${parsed.data.message}"`);
      }
    } else if (parsed.type === 'irc:exit') {
      console.error('IRC daemon exited!');
      client.user.setStatus('idle');
      client.user.setActivity(`nothing since I lost IRC connection at ${new Date()}`, { type: 'LISTENING' });
      sendToBotChan(`Lost IRC at **${new Date()}**!`);
    } else if (parsed.type === 'irc:notice') {
      const e = parsed.data;
      const mentionTarget = config.irc.registered[e.__drcNetwork].user.nick;
      sendToBotChan('`IRC:' + e.type.toUpperCase() + '` on `' + e.__drcNetwork + '`\n' +
        `\`From:\` **${e.nick}${e.from_server ? ' (SERVER!)' : ''}** <_${e.ident}@${e.hostname}_>\n` +
        `\`  To:\` **${e.target}**${e.target === mentionTarget && (config.user.notifyOnNotices || e.type === 'privmsg') ? allowedSpeakersMentionString() : ''}\n` +
        '```\n' + e.message + '\n```\n');
    } else if (type === 'irc' && subType === 'nick') {
      if (config.user.showNickChanges) {
        sendToBotChan('`IRC:NICK` ' + `**${parsed.data.nick}** <_${parsed.data.ident}@${parsed.data.hostname}_> changed nickname to **${parsed.data.new_nick}**`);
      }
    } else if (type === 'irc' && subType === 'whois') {
      const network = parsed.data.__drcNetwork;

      await runOneTimeHandlers(`${network}_${parsed.data.nick}`);

      delete parsed.data.__drcNetwork; // just so it doesn't show up in the output...
      sendToBotChan('`IRC:WHOIS` on `' + network + '` \n' + formatKVs(parsed.data));
    } else if (parsed.type === 'irc:responseWhois:nmap') {
      const wd = parsed.data.whoisData;

      const maxLen = Math.floor(config.discord.maxMsgLength * 0.9);
      for (let idx = 0; idx < parsed.data.stdout.length; idx += maxLen) {
        const str = '`IRC:WHOIS:NMAP` `STDOUT` ' +
          `(_page ${Math.floor(idx / maxLen) + 1}_) for **${wd.nick}** <_${wd.ident}@${wd.hostname}_>:` +
          '\n```\n' + parsed.data.stdout.slice(idx, idx + maxLen) + '\n```\n';

        console.debug(str);
        sendToBotChan(str);
      }

      if (parsed.data.stderr.length) {
        for (let idx = 0; idx < parsed.data.stderr.length; idx += maxLen) {
          const str = '`IRC:WHOIS:NMAP` `STDERR` ' +
            `(_page ${Math.floor(idx / maxLen) + 1}_) for **${wd.nick}** <_${wd.ident}@${wd.hostname}_>:` +
            '\n```\n' + parsed.data.stderr.slice(idx, idx + maxLen) + '\n```\n';

          console.debug(str);
          sendToBotChan(str);
        }
      }

      if (parsed.data.started) {
        sendToBotChan('`IRC:WHOIS:NMAP` ran for ' + fmtDuration(new Date(parsed.data.started)));
      }
    } else if (type === 'irc' &&
      (subType === 'topic' || subType === 'join' || subType === 'part' || subType === 'kick')) {
      const discName = resolveNameForDiscord(parsed.data.__drcNetwork, parsed.data.channel);
      const discId = channelsByName[parsed.data.__drcNetwork][discName];
      const chanSpec = categories[categoriesByName[parsed.data.__drcNetwork]].channels[channelsByName[parsed.data.__drcNetwork][discName]];

      if (subType === 'join' || subType === 'part') {
        const opts = [parsed.data.__drcNetwork, `<#${discId}>`];
        const ctx = {
          redis: new Redis(config.redis.url),
          options: {
            _: opts
          }
        };

        const showPerChan = await userCommands('showPerChan')(ctx, ...opts);
        ctx.redis.disconnect();

        if (showPerChan.indexOf(subType) === -1) {
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

      if (msgChan) {
        if (subType === 'part' || subType === 'join') {
          let sender = sendToBotChan;
          if ((subType === 'join' ? !config.user.joinsToBotChannel : true) && msgChan.__s) {
            sender = (s) => msgChan.__s(`(*${new Date().toLocaleTimeString()}*) ${s}`);
          }

          sender(`**${parsed.data.nick}** <_${parsed.data.ident}@${parsed.data.hostname}_> ${subType}ed${subType !== 'join' ? (config.user.joinsToBotChannel ? ` #${parsed.data.channel}: "${parsed.data.message}"` : ': "' + parsed.data.message + '"') : ''}`);
        } else if (subType === 'kick') {
          msgChan.send(`\`KICK\` **${parsed.data.kicked}** was kicked by **${parsed.data.nick}**: "${parsed.data.message}"`);
          sendToBotChan(`\`IRC:KICK\` **${parsed.data.kicked}** was kicked from **${parsed.data.channel}** by **${parsed.data.nick}**: "${parsed.data.message}"`);
        } else if (subType === 'topic' && parsed.data.topic) {
          msgChan.setTopic(parsed.data.topic);
        }
      } else {
        // skip our own parts, since the channel will necessarily have _already_ been deleted!
        if (config.irc.registered[parsed.data.__drcNetwork].user.nick !== parsed.data.nick) {
          if (subType === 'part') {
            sendToBotChan('`IRC:' + subType.toUpperCase() + '` ' + `**${parsed.data.nick}** <_${parsed.data.ident}@${parsed.data.hostname}_> ${parsed.data.channel} "${parsed.data.message}"`);
          }

          throw new Error(subType + '-- chan lookup failed', discName, chanSpec, parsed);
        } else {
          listenedToMutate.subOne();
        }
      }
    } else if (type === 'irc' && subType === 'motd') {
      sendToBotChan('`IRC:MessageOfTheDay` for network `' + parsed.data.__drcNetwork + '`\n```\n' + parsed.data.motd + '\n```\n');
    } else if (type === 'irc' && subType === 'numeric') {
      sendToBotChan('`IRC:' + subSubType + '` on ' + `\`${parsed.data.hostname || parsed.data.__drcNetwork}\`:\n>>> ${parsed.data.parsed ?? JSON.stringify(parsed.data.params)}`);
    } else if (type === 'irc' && subType === 'pong') {
      const [_drc, startTs] = parsed.data.message.split('-');
      const latencyToDiscord = new Date() - startTs;
      const embed = new MessageEmbed()
        .setColor('#22aaaa')
        .setTitle(`Latencies to \`${parsed.data.__drcNetwork}\``)
        .addFields(
          { name: 'To server', value: `${parsed.data.latencyToIRC}ms`, inline: true },
          { name: 'To us', value: `${latencyToDiscord}ms`, inline: true }
        )
        .addField('To all servers', '(in milliseconds)')
        .addFields(...stats.lastCalcs.lagAsEmbedFields)
        .setTimestamp();

      sendToBotChan(embed, true);
    } else if (type === 'irc') {
      if (['say', 'join', 'pong', 'tagmsg', 'action'].includes(subType) || (subType === 'responseSay' && !parsed.data)) {
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
    }
  } catch (e) {
    console.error('INTERNAL ERROR', e, msg);
    sendToBotChan('**INTERNAL ERROR**\n```\n' + `\n\n${e}\n\n${e.stack}\n\n${JSON.stringify(msg)}` + '\n```\n');
    ++stats.errors;

    if (ircReady.reject) {
      ircReady.reject(e);
    }
  }
};
