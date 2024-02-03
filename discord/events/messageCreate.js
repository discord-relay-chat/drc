'use strict';

const config = require('config');
const { PREFIX, resolveNameForIRC, PrivmsgMappings, matchNetwork, NetworkNotMatchedError } = require('../../util');
const {
  messageIsFromAllowedSpeaker,
  senderNickFromMessage,
  ticklePmChanExpiry,
  isNickInChan,
  cacheMessageAttachment,
  simpleEscapeForDiscord
} = require('../common');
const { MessageMentions: { CHANNELS_PATTERN }, MessageEmbed } = require('discord.js');

module.exports = async (context, data) => {
  const {
    sendToBotChan,
    channelMessageHandlers,
    client,
    allowedSpeakerCommandHandler,
    channelsById,
    categories,
    stats,
    redisClient,
    allowedSpeakersAvatars
  } = context;

  if (!messageIsFromAllowedSpeaker(data, context)) {
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

  allowedSpeakersAvatars[0] = data.author.displayAvatarURL();

  let replyNick;
  if (data.type === 'REPLY') {
    const repliedMsgId = data.reference.messageId;
    console.debug('REPLYING TO MSG ID' + repliedMsgId + ' in channel ID ' + data.channelId);
    const chan = await client.channels.cache.get(data.channelId);
    const replyMsg = await chan.messages.cache.get(repliedMsgId);
    console.debug('REPLYING TO MSG ' + replyMsg);
    replyNick = senderNickFromMessage(replyMsg);
  }

  if (data.channelId === config.irc.quitMsgChanId || data.content.trim()[0] === config.app.allowedSpeakersCommandPrefixCharacter) {
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
    let urls = [...data.attachments.entries()].map(([, att]) => att.url || att.attachment || att.proxyURL);

    if (config.http.enabled) {
      const failures = [];
      urls = (await Promise.all(urls.map(url => cacheMessageAttachment(context, url)))).map(cRes => {
        if (cRes.error) {
          console.error(`Caching of ${cRes.attachmentURL} failed:`, cRes.error);
          failures.push(cRes);
          return cRes.attachmentURL;
        }

        return cRes.cachedURL;
      });

      if (failures.length) {
        const embed = new MessageEmbed()
          .setTitle('Attachment caching failures:')
          .setDescription('One or more of your attachments could not be cached. Details follow.\n\n' +
          'For any with an "Unsupported Media Type" error, unfortunately Discord does not allow attaching of those file types.')
          .setColor(config.app.stats.embedColors.irc.nickIsGone);
        failures.forEach(({ attachmentURL, error }) => embed.addField(`"${error}"`, `URL: ${attachmentURL}`));
        await client.channels.cache.get(data.channelId).send({ embeds: [embed] });
      }
    }

    data.content += ' ' + urls.join(' ');
  }

  console.debug('messageCreate chan', channel);
  let emitThis = true;

  if (replyNick) {
    console.debug('Ghost nick check for', replyNick, 'in', channel, network.name);
    const nicRes = await isNickInChan(replyNick, channel.name, network.name, context.registerOneTimeHandler);
    console.debug('Ghost nick check result:', nicRes);

    const discReplyNick = simpleEscapeForDiscord(replyNick);
    emitThis = nicRes.nickInChan || nicRes.newNick;
    if (!emitThis) {
      const desc = `**${discReplyNick}** is no longer in this channel.\n\n` +
      'Your message to them (reproduced below) was _not_ sent.';
      const embed = new MessageEmbed()
        .setTitle(`${discReplyNick} is gone!`)
        .setDescription(desc)
        .setColor(config.app.stats.embedColors.irc.nickIsGone);
      embed.addField('Message content:', '> ' + data.content);
      console.log(`Ghost nick! "${replyNick}" ${channel.name}/${network.name}`);
      await client.channels.cache.get(data.channelId).send({ embeds: [embed] });
    } else {
      if (!nicRes.nickInChan && nicRes.newNick) {
        nicRes.newNick = simpleEscapeForDiscord(nicRes.newNick);
        await client.channels.cache.get(data.channelId).send({
          embeds: [new MessageEmbed()
            .setTitle('Reply target adjustment:')
            .setDescription(
              `\nNickname **${discReplyNick}** was changed to **${nicRes.newNick}**.\n\n` +
              'The target of your reply to them was adjusted accordingly.'
            )
            .setColor(config.app.stats.embedColors.irc.nickIsGone)]
        });

        replyNick = nicRes.newNick;
      }

      console.log(`Replying to <${replyNick}> in ${channel.name}/${network.name}`);
    }
  }

  if (emitThis) {
    if (replyNick) {
      data.content = `${replyNick}: ${data.content}`;
    }

    console.debug(`Emitting SAY with data.content: "${data.content}"`);

    let subType = 'say';
    if (data.content.indexOf('~me') === 0) {
      subType = 'action';
      data.content = data.content.replace('~me', '');
    }

    if (data.content.indexOf('~thinking') === 0) {
      subType = 'action';
      data.content = `. o O ( ${data.content.replace('~thinking', '')} )`;
    }

    if (data.content.match(CHANNELS_PATTERN)) {
      await Promise.all([...data.content.matchAll(CHANNELS_PATTERN)].map(async ([chanMatch, channelId]) => {
        const chanObj = channelsById[channelId];
        const parentObj = channelsById[chanObj.parent];

        const [, networkStub] = channel.name.split('_');
        try {
          network.name = matchNetwork(networkStub)?.network;
        } catch (e) {
          if (!(e instanceof NetworkNotMatchedError)) {
            throw e;
          }
        }

        let replacer = '#' + await resolveNameForIRC(network.name, chanObj.name);

        if (parentObj?.name !== network.name && channel.parent !== config.discord.privMsgCategoryId) {
          replacer += ` (on ${network.name})`;
        }

        data.content = data.content.replace(chanMatch, replacer);
      }));
    }

    if (channel.parent === config.discord.privMsgCategoryId) {
      const network /* shadowed! */ = await PrivmsgMappings.findNetworkForKey(data.channelId);
      console.log('PM CAT', channel, data.channelId, network, data.content);
      ticklePmChanExpiry(network, data.channelId);
      return await redisClient.publish(PREFIX, JSON.stringify({
        type: 'discord:requestSay:irc',
        data: {
          network,
          target: (await PrivmsgMappings.forNetwork(network))[data.channelId].target,
          message: data.content
        }
      }));
    }

    if (config.app.includeDiscordAuthorNameInIRCMessages) {
      data.content = `[${data.author.username}] ${data.content}`;
    }

    await redisClient.publish(PREFIX, JSON.stringify({
      type: 'irc:' + subType,
      data: {
        network: { name: network.name },
        channel: await resolveNameForIRC(network.name, channel.name),
        message: data.content
      }
    }));
  }

  if (config.user.deleteDiscordWithEchoMessageOn && config.irc.registered[network.name]?.user.enable_echomessage) {
    await data.delete();
  }
};
