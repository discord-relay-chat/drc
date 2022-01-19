'use strict';

const { getLogs, matchNetwork, resolveNameForIRC, searchLogs, fmtDuration, findFixedNonZero } = require('../../util');
const { serveMessages, formatKVs } = require('../common');
const { MessageMentions: { CHANNELS_PATTERN } } = require('discord.js');

const subCommands = {
  get: async (context, network) => {
    const [,, chanId] = context.argObj._;
    let resChan = chanId;
    const chanMatch = [...chanId.matchAll(CHANNELS_PATTERN)];

    if (chanMatch.length) {
      resChan = '#' + resolveNameForIRC(network, context.channelsById[chanMatch[0][1]].name);
    }

    const retList = await getLogs(network, resChan, context.options);

    serveMessages({ network, ...context }, retList.map((data) => ({
      timestamp: data.__drcIrcRxTs,
      data
    })));

    return `Query results for \`${network}\`:**${resChan}**:`;
  },

  search: async (context, network) => {
    const start = new Date();
    context.sendToBotChan(`Searching **${network}**, this may take awhile...`);

    const { totalLines, searchResults } = await searchLogs(network, context.options);
    const durFmtted = fmtDuration(start, true);
    const foundLines = Object.values(searchResults).reduce((a, x) => a + x.length, 0);
    const foundPrcnt = (foundLines / totalLines) * 100;

    if (!foundLines) {
      context.sendToBotChan(`Found no matching lines out of **${totalLines}** total. Search completed in **${durFmtted.length ? durFmtted : 'no time'}**.`);
    } else {
      context.sendToBotChan(`\n**Search result summary**; found **${foundLines}** matching lines out of **${totalLines}** total:\n\n` +
        formatKVs(Object.entries(searchResults).reduce((a, [chan, lines]) => ({
          [chan]: `${lines.length} line(s) found`,
          ...a
        }), {})) +
        `\n\n(representing ${findFixedNonZero(foundPrcnt)}% of the total lines in **${network}**'s logs)` +
        `\n\n_Search completed in **${durFmtted.length ? durFmtted : 'no time'}**_`);

      serveMessages({ network, ...context }, Object.values(searchResults).reduce((a, l) => a.concat(l), []).map((data) => ({
        timestamp: data.__drcIrcRxTs,
        data
      })));
    }
  }
};

async function f (context) {
  const [netStub, subCmd] = context.argObj._;
  const { network } = matchNetwork(netStub);

  if (!subCommands[subCmd]) {
    return `Bad subcommand "${subCmd}"`;
  }

  return subCommands[subCmd]?.(context, network);
}

f.__drcHelp = () => {
  return {
    title: 'Query & search IRC logs',
    usage: '<network> <subcommand> [arguments] [options]',
    notes: 'Anywhere a time value is required, it can either be anything parseable by `new Date()`, ' +
      '_or_ a duration value (negative of course, as searching into the future isn\'t quite perfect yet) ' +
      'such as "-1h" for "one hour in the past".\n\nDiscord channels will be correctly translated, if used.',
    subcommands: {
      get: {
        header: 'Directly queries the logs for the specified channel.',
        text: 'Sole argument is the channel to be queried.\n\n' +
        'Options:\n'
      },
      search: {
        header: 'Searches across all logs for the given network. Slower, but more capable, than `get`',
        text: 'Options:\n'
      }
    }
  };
};

module.exports = f;
