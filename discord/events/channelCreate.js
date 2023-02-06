'use strict';

const config = require('config');
const { PREFIX, ChannelXforms, scopedRedisClient } = require('../../util');
const crypto = require('crypto');
const { MessageActionRow, MessageButton, MessageEmbed } = require('discord.js');

module.exports = async (context, data) => {
  const {
    sendToBotChan,
    client,
    channelsById,
    categories,
    registerButtonHandler,
    channelsByName,
    listenedToMutate,
    deletedBeforeJoin,
    registerOneTimeHandler
  } = context;

  const { name, parentId, id } = data;
  const parentCat = categories[parentId];

  console.debug('channelCreate', name, parentId, id, parentCat);

  if (!parentCat || parentId === config.discord.privMsgCategoryId) {
    // channel was createed in top-level category or a privMsg category; we don't deal with those
    return;
  }

  const curXform = await ChannelXforms.get(parentCat.name, name);
  console.debug(curXform, parentCat.name, name, await ChannelXforms.forNetwork(parentCat.name));
  const buttonId = [parentId, id, crypto.randomBytes(8).toString('hex')].join('-');
  const embed = new MessageEmbed()
    .setTitle(`Ready to join \`#${name}\` on \`${parentCat.name}\`?`)
    .setColor('#00ff00')
    .addField('Don\'t want to join this channel after all?', 'Just click "Delete" and you\'re all set.')
    .setTimestamp();

  if (curXform) {
    embed.setDescription('This channel already has a transform defined, so when you click "Join" below ' +
      `we'll _actually_ join \`#${curXform}\` on \`${parentCat.name}\`.\n\nIf this is _not_ correct, adjust it with ` +
      `\`!channelXforms ${parentCat.name} set ${name} <newTransformName>\` ` +
      '_before clicking "Join"!_');
  } else {
    embed.setDescription('If a channel transform is needed for this channel, ' +
      `set it up now with \`!channelXforms ${parentCat.name} set ${name} <transformName>\` ` +
      '_before clicking "Join"!_');
  }

  const actRow = new MessageActionRow()
    .addComponents(
      new MessageButton().setCustomId(buttonId + '-ok').setLabel('Join').setStyle('SUCCESS'),
      new MessageButton().setCustomId(buttonId + '-del').setLabel('Delete').setStyle('DANGER')
    );

  registerButtonHandler(buttonId + '-ok', async (interaction) => {
    const refreshedXform = await ChannelXforms.forNetwork(parentCat.name)?.[name];
    interaction.update({
      components: [],
      embeds: [
        new MessageEmbed().setTitle(`Joined **#${name}**${refreshedXform ? ` (really \`#${refreshedXform})\`` : ''} on \`${parentCat.name}\`!`).setTimestamp()
      ]
    }).catch(console.error);

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

    await scopedRedisClient(async (c) => {
      await c.publish(PREFIX, JSON.stringify({
        type: 'discord:requestJoinChannel:irc',
        data: {
          name,
          id,
          parentId,
          networkName: parentCat.name
        }
      }));
    });
  });

  registerButtonHandler(buttonId + '-del', (interaction) => {
    deletedBeforeJoin[name] = id;

    const msg = `Removed channel ${name} (ID: ${id}) before join!`;
    interaction.update({
      components: [],
      embeds: [
        new MessageEmbed().setTitle(msg).setTimestamp()
      ]
    }).catch(console.error);

    sendToBotChan(msg);
    client.channels.cache.get(id).delete('Removed before join');
  });

  client.channels.cache.get(id).send({ embeds: [embed], components: [actRow] });
};
