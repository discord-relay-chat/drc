'use strict';

const {
  fmtDuration,
  ipInfo,
  scopedRedisClient,
  searchLogs,
  userLastSeen,
  userFirstSeen
} = require('../../util');
const { formatKVs, simpleEscapeForDiscord } = require('../common');
const userCommands = require('../userCommands');
const { MessageEmbed } = require('discord.js');

const logsSearch = async (network, d, embed, aliases = []) => {
  const lookups = [d.actual_ip, d.actual_hostname, d.hostname].filter(Boolean);
  const queryOptsTmpl = { distinct: true, strictStrings: true, columns: 'ident,nick,hostname' };
  if (!aliases.length && d.nick) {
    aliases.push(d.nick);
  }

  const logsSearchRes = [];

  if (d.ident && d.ident.length > 2) {
    const identSearch = await searchLogs(network, Object.assign({ ident: d.ident }, queryOptsTmpl));
    if (identSearch && identSearch.totalLines > 0) {
      logsSearchRes.push(identSearch.searchResults);
    }
  }

  for (const host of lookups.filter(Boolean)) {
    const hostSearch = await searchLogs(network, Object.assign({ host }, queryOptsTmpl));
    if (hostSearch && hostSearch.totalLines > 0) {
      logsSearchRes.push(hostSearch.searchResults);
    }
  }

  for (const alias of aliases) {
    const aliasSearch = await searchLogs(network, Object.assign({ nick: alias }, queryOptsTmpl));
    if (aliasSearch && aliasSearch.totalLines > 0) {
      logsSearchRes.push(aliasSearch.searchResults);
    }
  }

  const seenChannels = logsSearchRes.reduce((accSet, srObj) => {
    Object.keys(srObj).forEach((chan) => accSet.add(chan));
    return accSet;
  }, new Set());

  const uniqSearchRes = logsSearchRes.reduce((accObj, srObj) => {
    Object.values(srObj).forEach((objList) => objList.forEach((intObj) => Object.entries(intObj).forEach(([k, v]) => accObj[k]?.add(v))));
    return accObj;
  }, {
    hostname: new Set(),
    ident: new Set(),
    nick: new Set()
  });

  [
    ['spoken in channels:', [...seenChannels].map(simpleEscapeForDiscord).join(', ').substring(0, 1023)],
    ['appeared as nicks:', [...uniqSearchRes.nick].map(simpleEscapeForDiscord).join(', ').substring(0, 1023)],
    ['connected with idents:', [...uniqSearchRes.ident].map(simpleEscapeForDiscord).join(', ').substring(0, 1023)],
    ['connected from hostnames:', [...uniqSearchRes.hostname].map(simpleEscapeForDiscord).join(', ').substring(0, 1023)]
  ]
    .forEach(([title, renderedStr]) => {
      if (renderedStr.length) {
        embed.addField(title, renderedStr);
      }
    });
};

module.exports = async function (parsed, context) {
  const whoisRespStart = process.hrtime.bigint();
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

  console.log('WHOIS OPTS', parsed.data?.requestData?.options);
  const msgChan = client.channels.cache.get(parsed.data?.requestData?.channel);
  const network = d.__drcNetwork;

  const localSender = async (embed) => {
    if (msgChan) {
      return msgChan.send({ embeds: [embed] });
    } else {
      return sendToBotChan(embed, true);
    }
  };

  // so they don't show up in the output...
  delete d.__drcNetwork;
  delete d._orig;

  const lookupHost = d.actual_ip || d.actual_hostname || d.hostname;
  const ipInf = await ipInfo(lookupHost);

  const nickTracking = await userCommands('nicks');
  const ident = `${d.ident}@${d.hostname}`;

  // let hostMatchProcTime;
  const moreEmbeds = [];
  const embed = new MessageEmbed()
    .setColor('#2c759c')
    .setTitle(`WHOIS \`${d.nick}\` on \`${network}\`?`);

  if (d.error) {
    embed.setDescription('Nickname not found!');
    await logsSearch(network, d, embed);
    if (d.nick) {
      const lastSeens = await userLastSeen(network, d);
      if (lastSeens.length) {
        const lsEmbed = new MessageEmbed()
          .setColor('#2c759c')
          .setTitle(`Last seen info for \`${d.nick}\` on \`${network}\``);

        for (const [chan, date] of lastSeens) {
          lsEmbed.addField(date, `in ${chan}`);
        }

        moreEmbeds.push(lsEmbed);
      }
    }
  } else {
    embed.setDescription(formatKVs(d));

    if (ipInf) {
      embed.addField(`IP info for \`${lookupHost}\`:`, formatKVs(ipInf));
    }

    if (parsed.data?.requestData?.options.userFirstSeen) {
      const firstSeens = await userFirstSeen(network, d);
      if (firstSeens.length) {
        const [[chan, date]] = firstSeens;
        embed.addField('First seen on network:', `**${date}** in **${chan}**\n`);
      }
    }

    if (parsed.data?.requestData?.options.full) {
      let lookups = [d.actual_ip, d.actual_hostname, d.hostname];
      let lookupSet = new Set(lookups);

      const aliasesEmbed = new MessageEmbed()
        .setColor('#2c759c')
        .setTitle(`Aliases of \`${d.nick}\` on \`${network}\``);
      moreEmbeds.push(aliasesEmbed);

      await scopedRedisClient(async (rc, pfx) => {
        const hosts = (await rc.smembers(`${pfx}:hosttrack:${network}:${d.ident}`))
          .filter(x => !lookups.includes(x) && x.length);

        if (hosts?.length) {
          aliasesEmbed.addField(`Other known hosts for \`${d.ident}\` (${hosts?.length}):`,
            '`' + hosts.splice(0, 10).join('`, `') + '`' + (hosts?.length > 10 ? ', ...' : ''));
          hosts.forEach(lookupSet.add.bind(lookupSet));
          lookups.push(...hosts);
        }
      });

      const aliases = new Set();
      lookups = [...new Set(lookups)];

      const addIdentToEmbed = async (identLookup, e, searchStr) => {
        const identData = await nickTracking.identLookup(network, identLookup);
        if (identData) {
          e.addField(`Known aliases of <\`${identData.fullIdent}\`>` +
            `${searchStr ? ` (from "${searchStr}")` : ''}:`,
          identData.uniques.map(simpleEscapeForDiscord).join(', ') +
            (identData.lastChanges.length
              ? `\n\nLast nick change was ${fmtDuration(identData.lastChanges[0].timestamp)} ago.`
              : ''));
          identData.uniques.forEach((id) => aliases.add(id));
        }
      };

      const ignoreIdents = await userCommands('identsIgnored')(context, network);
      if (!ignoreIdents.includes(d.ident) && d.ident.length > 2) {
        await addIdentToEmbed(ident, aliasesEmbed);

        lookupSet = new Set([...lookupSet].filter(x => Boolean(x)));
        console.debug('lookupSet', lookupSet);

        for (const lookupHost of lookupSet) {
          const uniqueIdents = await nickTracking.findUniqueIdents(network, lookupHost);
          for (const uniqIdent of uniqueIdents) {
            if (uniqIdent !== ident) {
              await addIdentToEmbed(uniqIdent, aliasesEmbed, lookupHost);
            }
          }
        }

        const logsEmbed = new MessageEmbed()
          .setColor('#2c759c')
          .setTitle(`On \`${network}\`, \`${d.nick}\` has...`);
        await logsSearch(network, d, logsEmbed, [...aliases]);
        moreEmbeds.push(logsEmbed);
      }
    }

    const notes = await userCommands('notes')(Object.assign({
      options: parsed.data?.requestData?.options
    }, context), ...parsed.data?.requestData?.options._);
    if (notes && notes.length) {
      const notesEmbed = new MessageEmbed()
        .setColor('#2c759c')
        .setTitle(`Notes regarding \`${d.nick}\` on \`${network}\``);
      moreEmbeds.push(notesEmbed);
      notesEmbed.setDescription(notes.reduce((a, note) => {
        if (typeof note === 'string') {
          a += `• ${note}\n`;
        }
        return a;
      }, ''));
    }
    await scopedRedisClient(async (rc, pfx) => {
      const zScore = await rc.zscore(`${pfx}:kicks:${network}:kickee`, d.nick);
      if (zScore > 2) {
        embed.addField('Toxic user alert!', `**${d.nick}** has been kicked from channels **${zScore}** times on this network!`);
      }
    });
  }

  if (!d.error) {
    const txToProc = Number(new Date()) - parsed.data?.requestData?.txTs;
    const procTime = Number(process.hrtime.bigint() - whoisRespStart) / 1e9;
    const procTimeStr = `Roundtrip took ${(txToProc / 1e3).toFixed(2)} seconds & processing took ${procTime.toFixed(2)} seconds `;
    embed.setFooter(procTimeStr);
  }

  await localSender(embed);
  for (const another of moreEmbeds) {
    await localSender(another);
  }

  await runOneTimeHandlers(`${network}_${d._orig?.nick ?? d.nick}`);
};
