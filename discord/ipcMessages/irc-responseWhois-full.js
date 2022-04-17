'use strict';

const {
  fmtDuration,
  ipInfo,
  scopedRedisClient
} = require('../../util');
const { formatKVs, simpleEscapeForDiscord } = require('../common');
const userCommands = require('../userCommands');
const { MessageEmbed } = require('discord.js');

module.exports = async function (parsed, context) {
  const {
    client,
    sendToBotChan,
    runOneTimeHandlers
  } = context;
  const d = parsed.data?.whoisData;
  console.debug('irc-RF-whois data', d, parsed);

  if (!d) {
    console.error('bad!');
    return;
  }

  const msgChan = client.channels.cache.get(parsed.data?.requestData?.channel);
  const network = d.__drcNetwork;

  await runOneTimeHandlers(`${network}_${d._orig?.nick ?? d.nick}`);

  // so they don't show up in the output...
  delete d.__drcNetwork;
  delete d._orig;

  const lookupHost = d.actual_ip || d.actual_hostname || d.hostname;
  const ipInf = await ipInfo(lookupHost);

  const nickTracking = await userCommands('nicks');
  const ident = `${d.ident}@${d.hostname}`;
  const identData = await nickTracking.identLookup(network, ident);
  console.debug('whois ident lookup result', network, ident, identData);

  const embed = new MessageEmbed()
    .setColor('#2c759c')
    .setTitle(`WHOIS \`${d.nick}\` on \`${network}\`?`);

  if (d.error) {
    embed.setDescription('Nickname not found!');
  } else {
    embed.setDescription(formatKVs(d));

    if (ipInf) {
      embed.addField(`IP info for \`${lookupHost}\`:`, formatKVs(ipInf));
    }

    const lookups = [d.actual_ip, d.actual_hostname, d.hostname];
    let lookupSet = new Set(lookups);
    await scopedRedisClient(async (rc, pfx) => {
      const hosts = (await rc.smembers(`${pfx}:hosttrack:${network}:${d.ident}`))
        .filter(x => !lookups.includes(x) && x.length);

      if (hosts?.length) {
        embed.addField(`Other known hosts for \`${d.ident}\` (${hosts?.length}):`,
          '`' + hosts.splice(0, 10).join('`, `') + '`' + (hosts?.length > 10 ? ', ...' : ''));
        hosts.forEach(lookupSet.add.bind(lookupSet));
      }
    });

    const addIdentToEmbed = async (identLookup, e, searchStr) => {
      const identData = await nickTracking.identLookup(network, identLookup);
      if (identData) {
        e.addField(`Known aliases of <\`${identData.fullIdent}\`>` +
          `${searchStr ? ` (from "${searchStr}")` : ''}:`,
        '`' + identData.uniques.filter(simpleEscapeForDiscord).join('`, `') + '`' +
          (identData.lastChanges.length
            ? `\n\nLast nick change was ${fmtDuration(identData.lastChanges[0].timestamp)} ago.`
            : ''));
      }
    };

    await addIdentToEmbed(ident, embed);

    if (!['~user', '~quassel'].includes(d.ident)) {
      lookupSet = new Set([...lookupSet].filter(x => Boolean(x)));
      console.debug('lookupSet', lookupSet);

      await Promise.all([...lookupSet]
        .map(async (lookupHost) => Promise.all((await nickTracking.findUniqueIdents(network, lookupHost))
          .filter((i) => i !== ident)
          .map(async (uniqIdent) => addIdentToEmbed(uniqIdent, embed, lookupHost)))));
    }

    await scopedRedisClient(async (rc, pfx) => {
      const zScore = await rc.zscore(`${pfx}:kicks:${network}:kickee`, d.nick);
      if (zScore) {
        embed.addField('Toxic user alert!', `**${d.nick}** has been kicked from channels **${zScore}** times on this network!`);
      }
    });
  }

  if (msgChan) {
    msgChan.send({ embeds: [embed] });
  } else {
    sendToBotChan(embed, true);
  }
};
