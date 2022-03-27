'use strict';

const {
  fmtDuration,
  ipInfo
} = require('../../util');
const { formatKVs } = require('../common');
const userCommands = require('../userCommands');
const { MessageEmbed } = require('discord.js');

module.exports = async function (parsed, context) {
  const {
    sendToBotChan,
    runOneTimeHandlers
  } = context;
  const d = parsed.data;
  const network = d.__drcNetwork;

  await runOneTimeHandlers(`${network}_${d._orig.nick ?? d.nick}`);

  // so they don't show up in the output...
  delete d.__drcNetwork;
  delete d._orig;

  const lookupHost = d.actual_ip || d.actual_hostname || d.hostname;
  const ipInf = await ipInfo(lookupHost);

  const nickTracking = await userCommands('nickTracking');
  const ident = `${d.ident}@${d.hostname}`;
  const identData = await nickTracking.identLookup(network, ident);
  console.debug('whois ident lookup result', network, ident, identData);

  const embed = new MessageEmbed()
    .setColor('#2c759c')
    .setTitle(`WHOIS \`${d.nick}\` on \`${network}\`?`)
    .setDescription(formatKVs(d));

  if (ipInf) {
    embed.addField(`IP info for \`${lookupHost}\`:`, formatKVs(ipInf));
  }

  const addIdentToEmbed = async (identLookup, e, searchStr) => {
    const identData = await nickTracking.identLookup(network, identLookup);
    if (identData) {
      e.addField(`Known aliases of <\`${identData.fullIdent}\`>` +
        `${searchStr ? ` (from "${searchStr}")` : ''}:`,
      '`' + identData.uniques.join('`\n`') + '`' +
        (identData.lastChanges.length
          ? `\n\nLast nick change was ${fmtDuration(identData.lastChanges[0].timestamp)} ago.`
          : ''));
    }
  };

  await addIdentToEmbed(ident, embed);

  await Promise.all([...new Set([d.actual_ip, d.actual_hostname, d.hostname])]
    .map(async (lookupHost) => Promise.all((await nickTracking.findUniqueIdents(network, lookupHost))
      .filter((i) => i !== ident)
      .map(async (uniqIdent) => addIdentToEmbed(uniqIdent, embed, lookupHost)))));

  sendToBotChan(embed, true);
};
