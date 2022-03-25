'use strict';

const { matchNetwork, PREFIX, scopedRedisClient } = require('../../util');
const { MessageEmbed } = require('discord.js');
const { formatKVs } = require('../common');

async function identLookup (network, identStr) {
  const rKey = [PREFIX, network, 'nicktrack', identStr].join(':');
  const uniqKey = [rKey, 'uniques'].join(':');
  const chKey = [rKey, 'changes'].join(':');

  return scopedRedisClient(async (rc) => {
    if (Boolean(await rc.exists(uniqKey)) && Boolean(await rc.exists(chKey))) {
      return {
        fullIdent: identStr,
        uniques: await rc.smembers([rKey, 'uniques'].join(':')),
        lastChanges: (await rc.lrange([rKey, 'changes'].join(':'), 0, 2)).map(JSON.parse)
      };
    }

    return null;
  });
}

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

  const sendNickTrackData = async ({ fullIdent, uniques, lastChanges }) => {
    const em = new MessageEmbed()
      .setTitle(`Nick tracking for \`${fullIdent}\`:`)
      .addField(`Has been seen as the following ${uniques.length} nicks:`, '* ' + uniques.join('\n* '))
      .addField('The last 3 nick-change events:', lastChanges.map(x => formatKVs(x)).join('\n\n'));
    await context.sendToBotChan(em, true);
  };

  let identData = await identLookup(network, identStr);

  if (!identData) {
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

      identData = await identLookup(network, (identStr = uniqIdents[0]));
      context.sendToBotChan(`Found matching ident <\`${identStr}\`>...`);
    }
  }

  if (identData) {
    console.debug('ident data', network, identStr, identData);
    await sendNickTrackData(identData);
  } else {
    context.sendToBotChan(`No known ident \`${identStr}\`, and could not find any matching.`);
  }
}

f.identLookup = identLookup;
module.exports = f;
