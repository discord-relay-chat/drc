'use strict';

const { resolveNameForIRC } = require('../../util');
const { simpleEscapeForDiscord, getNetworkAndChanNameFromUCContext } = require('../common');
const { MessageEmbed } = require('discord.js');

async function f (context, ...a) {
  const { network, channelName } = getNetworkAndChanNameFromUCContext(context);

  if (!network || !channelName) {
    return `Unable to determine network ("${network}") or channel ("${channelName}")`;
  }

  console.log(network, channelName);
  const channel = '#' + resolveNameForIRC(network, channelName);
  context.registerOneTimeHandler('irc:responseUserList', channel, async (data) => {
    const { channel: { name, users }, network } = data;

    const sorter = (a, b) => a.nick.localeCompare(b.nick);
    const ops = users.filter((u) => u.modes.includes('o')).sort(sorter);
    const voiced = users.filter((u) => u.modes.includes('v')).sort(sorter);
    const regular = users.filter((u) => !u.modes.length).sort(sorter);

    const mapper = (o) => `${simpleEscapeForDiscord(o.nick)}` + (o.ident.length && o.hostname.length ? ` <_${o.ident}@${o.hostname}_>` : '');
    const joiner = ', ';

    const sender = (e) => {
      data.__othHelpers.msgChan.send({ embeds: [e] });
    };

    if (ops.length || voiced.length) {
      const embed = new MessageEmbed()
        .setTitle(`Privileged user list for _${name}_ on \`${network}\``)
        .setDescription(`Total user count: **${users.length}**`)
        .setTimestamp();

      if (ops.length) {
        embed.addField('Operators:', ops.map(mapper).join(joiner));
      }

      if (voiced.length) {
        embed.addField('Voiced:', voiced.map(mapper).join(joiner));
      }

      sender(embed);
    }

    if (regular.length) {
      if (!context.options.full) {
        sender(new MessageEmbed()
          .setTitle(`_${name}_ on \`${network}\` has **${regular.length}** regular users.`)
          .setTimestamp());

        return;
      }

      const SL = 100;
      let sStart = 0;
      let pg = 1;
      do {
        const s = regular.slice(sStart, sStart + SL).map(mapper).join(joiner);
        if (s.length) {
          sender(new MessageEmbed()
            .setTitle(`Regular user list for _${name}_ on \`${network}\` (page **${pg++}**; counts ${sStart + 1} - ${sStart + 1 + SL})`)
            .setDescription(s)
            .setTimestamp());
        }

        sStart += SL;
      } while (sStart < (regular.length - SL));

      if (sStart < regular.length) {
        const s = regular.slice(sStart, regular.length - 1).map(mapper).join(joiner);
        if (s.length) {
          sender(new MessageEmbed()
            .setTitle(`Regular user list for **${name}** on \`${network}\` (page **${pg++}**; counts ${sStart + 1} - ${regular.length})`)
            .setDescription(s)
            .setTimestamp());
        }
      }
    }
  });

  await context.publish({
    type: 'discord:requestUserList:irc',
    data: {
      network,
      channel
    }
  });
}

module.exports = f;
