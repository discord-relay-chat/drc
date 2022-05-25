'use strict';

const config = require('config');
const { PREFIX, resolveNameForIRC, PrivmsgMappings } = require('../../util');
const { messageIsFromAllowedSpeaker, senderNickFromMessage, ticklePmChanExpiry } = require('../common');
const { MessageMentions: { CHANNELS_PATTERN } } = require('discord.js');

module.exports = async (context, data) => {
  const {
    sendToBotChan,
    channelMessageHandlers,
    client,
    allowedSpeakerCommandHandler,
    channelsById,
    categories,
    stats,
    redisClient
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

  let replyNick;
  if (data.type === 'REPLY') {
    const repliedMsgId = data.reference.messageId;
    console.debug('REPLYING TO MSG ID' + repliedMsgId + ' in channel ID ' + data.channelId);
    const chan = await client.channels.cache.get(data.channelId);
    const replyMsg = await chan.messages.cache.get(repliedMsgId);
    console.debug('REPLYING TO MSG ' + replyMsg);
    replyNick = senderNickFromMessage(replyMsg);
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
  if (data.content.indexOf('~me') === 0) {
    subType = 'action';
    data.content = data.content.replace('~me', '');
  }

  if (data.content.indexOf('~thinking') === 0) {
    subType = 'action';
    data.content = `. o O ( ${data.content.replace('~thinking', '')} )`;
  }

  if (data.content.match(CHANNELS_PATTERN)) {
    [...data.content.matchAll(CHANNELS_PATTERN)].forEach(([chanMatch, channelId]) => {
      const chanObj = channelsById[channelId];
      const parentObj = channelsById[chanObj.parent];

      console.debug('CONTENT MATCH', chanMatch, channelId, channelsById[channelId], resolveNameForIRC(network.name, chanObj.name), parentObj);

      let replacer = '#' + resolveNameForIRC(network.name, chanObj.name);

      if (parentObj?.name !== network.name && channel.parent !== config.discord.privMsgCategoryId) {
        replacer += ` (on ${network.name})`;
      }

      data.content = data.content.replace(chanMatch, replacer);
    });
  }

  if (channel.parent === config.discord.privMsgCategoryId) {
    const network /* shadowed! */ = PrivmsgMappings.findNetworkForKey(data.channelId);
    console.log('PM CAT', channel, data.channelId, network, PrivmsgMappings.forNetwork(network), data.content);
    ticklePmChanExpiry(network, data.channelId);
    return await redisClient.publish(PREFIX, JSON.stringify({
      type: 'discord:requestSay:irc',
      data: {
        network,
        target: PrivmsgMappings.forNetwork(network)[data.channelId].target,
        message: data.content
      }
    }));
  }

  await redisClient.publish(PREFIX, JSON.stringify({
    type: 'irc:' + subType,
    data: {
      network: { name: network.name },
      channel: resolveNameForIRC(network.name, channel.name),
      message: data.content
    }
  }));

  if (config.user.deleteDiscordWithEchoMessageOn && config.irc.registered[network.name]?.user.enable_echomessage) {
    await data.delete();
  }
};
