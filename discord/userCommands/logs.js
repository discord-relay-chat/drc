'use strict';

const { MessageEmbed } = require('discord.js');
const { matchNetwork, searchLogs, fmtDuration, resolveNameForDiscord } = require('../../util');
const { serveMessages } = require('../common');
const { transformAveragesForDigestHTTP, roundSentimentScoreOnMessages } = require('../../lib/sentiments');

const search = async (context, network, titleMessage = `Searching **${network}**...`) => {
  const start = new Date();
  context.sendToBotChan(titleMessage);

  console.debug('SEARCH opts', context.options);
  const { totalLines, searchResults, error, sentiments } = await searchLogs(network, context.options);

  if (error) {
    context.sendToBotChan('Search failed: \n```\n' + error + '\n```\n');
    return;
  }

  const durFmtted = fmtDuration(start, true);
  const delta = new Date() - start;
  const foundLines = Object.values(searchResults).reduce((a, x) => a + x.length, 0);
  const { categoriesByName, channelsById } = context;

  if (!foundLines) {
    context.sendToBotChan(`Found no matching lines out of **${totalLines}** total.\n` +
    'Not expecting zero results? Try with `--everything`, `--orKeys`, and/or a different `--type`.\n' +
    `Search completed in **${durFmtted.length ? durFmtted : 'no time'}** (${delta}).`);
  } else {
    const networkCatIds = Object.fromEntries(Object.entries(categoriesByName).filter(([k]) => k === network))[network];
    const networkChannels = Object.entries(channelsById)
      .filter(([, { parent }]) => networkCatIds.includes(parent))
      .reduce((a, [id, { name }]) => ({
        [name]: id,
        ...a
      }), {});

    const embed = new MessageEmbed()
      .setTitle(`**${foundLines}** matching lines`)
      .setColor('DARK_GOLD')
      .setFooter(`Search completed in ${durFmtted.length ? durFmtted : 'no time'} (${delta})`);

    const cTrim = (cs) => cs.replaceAll('#', '').toLowerCase();

    const resolveMeSerially = Object.entries(searchResults)
      .sort(([chanA], [chanB]) => cTrim(chanA).localeCompare(cTrim(chanB)))
      .sort(([, linesA], [, linesB]) => linesB.length - linesA.length)
      .map(async ([chan, lines]) => {
        return [chan, lines, await resolveNameForDiscord(network, chan)];
      });

    for (const r of resolveMeSerially) {
      const [chan, lines, discResolved] = await r;
      const discordChannelId = networkChannels[discResolved];
      if (!discordChannelId) {
        console.warn('No channel ID! (may be expected if channel was a PM channel or was otherwise removed)',
          discordChannelId, networkChannels, cTrim(chan), chan, discResolved);
      }
      let chanStr = discordChannelId ? `<#${discordChannelId}>` : chan;
      if (sentiments && sentiments.perChan[chan]) {
        const { score, comparative } = sentiments.perChan[chan];
        chanStr += `\nsentiment: ${Number(comparative).toFixed(3)} (${Number(score).toFixed(1)})`;
      }
      embed.addField(`${lines.length} line(s) found in`, chanStr);
    }

    context.sendToBotChan({ embeds: [embed] }, true);

    if (!context.options?.doNotServe) {
      let serveData = [];
      const onlySentiment = context.options.justSentiment || context.options.onlySentiment;
      if (!onlySentiment) {
        serveData = Object.values(searchResults)
          .reduce((a, l) => a.concat(l), [])
          .map((data) => ({
            timestamp: data.__drcIrcRxTs,
            data
          }));
      } else {
        context.options.serve = true;
      }

      roundSentimentScoreOnMessages(serveData.map(({ data }) => data));
      serveMessages({ network, ...context }, serveData, {
        extra: {
          sentiments: transformAveragesForDigestHTTP(sentiments)
        }
      });
    }
  }
};

async function f (context) {
  const [netStub, subCmd, subCmdArg1] = context.argObj._;
  const { network } = matchNetwork(netStub);

  if (subCmd) {
    let subParsed;
    if (subCmd === 'digest' && subCmdArg1 && !Number.isNaN((subParsed = Number.parseInt(subCmdArg1)))) {
      context.options = {
        ...context.options,
        from: `-${subParsed}m`,
        doNotServe: !(context.options?.serve ?? false)
      };

      return search(context, network, `Producing digest of last **${subParsed} minutes** of activity...`);
    }
  }

  return search(context, network)
    .catch(e => {
      console.error('search failed', e);
      context.sendToBotChan(`Search failed: ${e}`);
    });
}

f.__drcHelp = () => {
  return {
    title: 'Query & search IRC logs',
    usage: '<network> [arguments] [options]',
    notes: 'Anywhere a time value is required, it may be anything parseable by `new Date()`, ' +
      '_or_ a duration value (negative of course, as searching into the future isn\'t quite perfect yet).' +
      '\n\nExamples:\n\t• `-1h` for "one hour in the past".\n\t' +
      '• `2022-12-25T23:59:00` for "right before Santa arrives"\n' +
      '• `"Mon Jan 23 2023 20:58:00 PST"` for "9:58PM on Monday January 23rd 2023 in the Pacific Time Zone"\n' +
      '• `"three days ago"` for "three days ago"\n\n' +
      'Fields that take string arguments (pretty much any *but* time' +
      'fields) may include the SQLite wildcard characters "%" and "_", where their meaning is as-expected.',
    options: [
      ['--from', 'The oldest time from which to fetch messages', true],
      ['--to', 'The youngest time from which to fetch messages', true],
      ['--message', 'The message contents to search for', true],
      ['--nick', 'The nickname to search for', true],
      ['--channel', 'The channel (or target) to search for; `--target` is an allowed synonym.', true],
      ['--host', 'The host (hostname) to search for; `--hostname` is an allowed synonym.', true],
      ['--ident', 'The user ident to search for', true],
      ['--type', 'The message type ("notice", "privmsg", etc) to search for', true],
      ['--columns', 'A comma-separated list of columns to include', true],
      ['--from_server', 'Only include messages that originated from the server', false],
      ['--orKeys', 'Comma-seperated list of the search keys (all of the above) to OR together in the query', false],
      ['--everything', 'Include all sources; default is just channels', false],
      ['--distinct', 'Apply DISTINCT to the search', false]
    ]
  };
};

f.search = search;

module.exports = f;
