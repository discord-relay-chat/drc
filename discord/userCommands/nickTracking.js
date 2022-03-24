'use strict';

const { matchNetwork, PREFIX } = require('../../util');
const { MessageEmbed } = require('discord.js');

async function f (context, ...a) {
  let [netStub, identStr] = a;
  const { network } = matchNetwork(netStub);

  if (!network) {
    return `Unknown network '${network}'`;
  }

  if (!identStr || !identStr.length) {
    const uniqIdents = [...new Set((await context.redis.keys([PREFIX, network, 'nicktrack'].join(':') + '*'))
      .map(x => x.split(':')[3]))];

    if (!uniqIdents.length) {
      context.sendToBotChan(`No idents yet tracked for **${network}**`);
    } else {
      context.sendToBotChan(`All unique, tracked idents for **${network}**: \`${uniqIdents.join('`, `')}\``);
    }

    return;
  }

  const rKey = [PREFIX, network, 'nicktrack', identStr].join(':');
  const uniqKey = [rKey, 'uniques'].join(':');
  const chKey = [rKey, 'changes'].join(':');

  let directIdentExists = Boolean(await context.redis.exists(uniqKey)) &&
    Boolean(await context.redis.exists(chKey));

  const fetchAndSendNickTrackData = async (fullIdent) => {
    const fullKey = [PREFIX, network, 'nicktrack', fullIdent].join(':');
    const uniques = await context.redis.smembers([fullKey, 'uniques'].join(':'));
    const lastChanges = await context.redis.lrange([fullKey, 'changes'].join(':'), 0, 4);

    const em = new MessageEmbed()
      .setTitle(`Nick tracking for \`${fullIdent}\`:`)
      .addField(`Has also been seen as the following **${uniques.length}** nicks:`, uniques.join('\n'))
      .addField('The last 5 change events:', '```json\n' + lastChanges
        .map(JSON.parse)
        .map(x => JSON.stringify(x, null, 2))
        .join('\n```\n```json\n') + '\n```');

    context.sendToBotChan(em, true);
  };

  if (!directIdentExists) {
    const searchKey = [PREFIX, network, 'nicktrack', '*' + identStr + '*'].join(':');
    const foundKeys = await context.redis.keys(searchKey);

    if (foundKeys.length) {
      const uniqIdents = [...new Set(foundKeys.map(x => x.split(':')[3]))];

      if (foundKeys.length !== 2) {
        const em = new MessageEmbed()
          .setTitle(`Multiple possible idents found for \`${identStr}\`:`)
          .setDescription('`' + uniqIdents.join('`\n`') + '`');

        context.sendToBotChan(em, true);
        return;
      }

      identStr = uniqIdents[0];
      directIdentExists = true;
      context.sendToBotChan(`Found matching ident <\`${identStr}\`>...`);
    }
  }

  if (directIdentExists) {
    await fetchAndSendNickTrackData(identStr);
  } else {
    context.sendToBotChan(`No known ident \`${identStr}\`, and could not find any matching.`);
  }
}

module.exports = f;
