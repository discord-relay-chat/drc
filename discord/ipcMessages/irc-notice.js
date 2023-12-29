'use strict';

const config = require('config');
const crypto = require('crypto');
const userCommands = require('../userCommands');
const {
  fmtDuration,
  replaceIrcEscapes,
  PrivmsgMappings,
  scopedRedisClient
} = require('../../util');
const {
  ticklePmChanExpiry,
  persistPmChan
} = require('../common');
const { MessageEmbed, MessageActionRow, MessageButton } = require('discord.js');
const { wrapUrls } = require('../../lib/wrapUrls');

module.exports = async function (parsed, context) {
  const {
    serialize,
    stats,
    registerButtonHandler,
    sendToBotChan,
    client,
    channelsById,
    allowedSpeakersMentionString,
    pendingAliveChecks
  } = context;
  const e = parsed.data;
  const mentionTarget = config.irc.registered[e.__drcNetwork].user.nick;
  const isIgnored = await scopedRedisClient(async (redis) => {
    const ignoreList = await userCommands('ignore')({ redis }, e.__drcNetwork);

    if (ignoreList && Array.isArray(ignoreList) && ignoreList.includes(e._orig.nick)) {
      stats.messages.ignored++;
      return '||';
    }

    return '';
  });

  if (isIgnored && config.user.squelchIgnored) {
    await scopedRedisClient(async (redis) => {
      await (await userCommands('ignore')({ redis }, e.__drcNetwork, '_squelchMessage'))({ timestamp: new Date(), data: e });
    });
    return;
  }

  e.message = replaceIrcEscapes(e.message);

  if (!e.nick || e.nick.length === 0) {
    e.nick = 'Server';
  }

  if (config.discord.privMsgCategoryId) {
    if (e.nick in pendingAliveChecks) {
      console.info(`Got RX of alive check for ${e.nick}`);
      clearTimeout(pendingAliveChecks[e.nick]);
      delete pendingAliveChecks[e.nick];
      return;
    }

    serialize(async () => {
      let chanId = Object.entries(await PrivmsgMappings.forNetwork(e.__drcNetwork)).find(([, obj]) => obj.target === e._orig.nick)?.[0];
      let newChan, created;

      if (chanId) {
        const extantChan = await client.channels.cache.get(chanId);
        if (!extantChan) {
          PrivmsgMappings.remove(e.__drcNetwork, chanId);
          chanId = null;
        }
      }

      if (!chanId) {
        const netTrunc = e.__drcNetwork.split('.');
        const netTruncName = netTrunc.length ? netTrunc[netTrunc.length - 2] : e.__drcNetwork;
        const newName = `${e.nick}_${netTruncName}`;
        created = new Date(Math.floor(Number(new Date()) / 1e3) * 1e3);

        newChan = await client.guilds.cache.get(config.discord.guildId).channels.create(newName, {
          parent: config.discord.privMsgCategoryId,
          topic: `Private messages with **${e.nick}** on **${e.__drcNetwork}**. Originally opened **${created.toDRCString()}** ` +
            `& will be removed after ${fmtDuration(0, false, config.discord.privMsgChannelStalenessTimeMinutes * 60 * 1000)} with no activity. `
        });

        channelsById[newChan.id] = {
          name: newChan.name,
          parent: newChan.parentId
        };

        chanId = newChan.id;

        created = Number(created);
        await PrivmsgMappings.set(e.__drcNetwork, newChan.id, {
          target: e._orig.nick,
          channelName: newChan.name,
          created
        });

        console.log('Create PM chan', newChan.name, newChan.id);
      }

      const expTimes = await ticklePmChanExpiry(e.__drcNetwork, chanId);

      if (newChan) {
        const { id } = newChan;
        const rmWarnEmbed = new MessageEmbed()
          .setColor(config.app.stats.embedColors.irc.privMsg)
          .setTitle(`Private messages with **${e.nick}** on **${e.__drcNetwork}**`)
          .setDescription(`This channel will be removed after ${expTimes.humanReadable.origMins} with no activity. ` +
          `A warning will be issued when ${expTimes.stalenessPercentage}% of that time - ${expTimes.humanReadable.remainMins} - remains.`)
          .addField('**Alternatively,** make the channel permanent with the button below',
            'But **be warned**, Discord restricts categories to a maximum of 50 channels!');

        const permId = [id, crypto.randomBytes(8).toString('hex')].join('-');
        const keepId = [id, crypto.randomBytes(8).toString('hex')].join('-');
        const actRow = new MessageActionRow()
          .addComponents(
            new MessageButton().setCustomId(permId).setLabel('Make channel permanent').setStyle('DANGER'),
            new MessageButton().setCustomId(keepId).setLabel('Keep the countdown').setStyle('SUCCESS')
          );

        const msg = await client.channels.cache.get(id).send({ embeds: [rmWarnEmbed], components: [actRow] });

        registerButtonHandler(permId, async (interaction) => {
          await persistPmChan(e.__drcNetwork, id);
          newChan.setTopic(`Private messages with **${e.nick}** on **${e.__drcNetwork}**. Originally opened **${new Date(created).toDRCString()}**.`);
          interaction.update({
            embeds: [new MessageEmbed()
              .setColor('#00ff00')
              .setTitle('Channel is now permanent!')
              .setDescription('This message will self-destruct in 1 minute...')],
            components: []
          });
          setTimeout(() => msg.delete().catch(console.error), 60 * 1000);
        });

        registerButtonHandler(keepId, async (interaction) => {
          await ticklePmChanExpiry(e.__drcNetwork, id);
          interaction.update({
            embeds: [new MessageEmbed()
              .setColor('#00ff00')
              .setTitle('Keeping the countdown :+1:')
              .setDescription('This message will self-destruct in 1 minute...')],
            components: []
          });
          setTimeout(() => msg.delete().catch(console.error), 60 * 1000);
        });
      }

      const msChar = config.user.monospacePrivmsgs ? '`' : '';
      const msg = msChar + isIgnored + wrapUrls(e.message) + isIgnored + msChar;

      if (msg.length && !e.message.match(/^\s*$/g)) {
        try {
          await client.channels.cache.get(chanId)?.send(msg);
        } catch (err) {
          console.error('send err', '[', msg, ']', msg.length, err);
        }
      }
    });
  } else {
    const embed = new MessageEmbed()
      .setColor(config.app.stats.embedColors.irc.privMsg)
      .setTitle(`Private message on \`${e.__drcNetwork}\`:`)
      .addField('`From:`', `**${e.nick}${e.from_server ? ' (SERVER!)' : ''}** <_${e.ident}@${e.hostname}_>`)
      .addField('`To:`', `**${e.target}**`)
      .setDescription('```\n' + isIgnored + e.message + isIgnored + '\n```\n')
      .setTimestamp();

    if (e.target === mentionTarget && isIgnored === '' && (config.user.notifyOnNotices || e.type === 'privmsg')) {
      await sendToBotChan(`:arrow_down: :rotating_light: :mega: ${allowedSpeakersMentionString(['', ''])}`);
    }

    await sendToBotChan(embed, true);
  }
};
