'use strict';

const UCHistory = require('../userCommandHistory');
const { MessageEmbed } = require('discord.js');
const { formatKVsWithOpts } = require('../common');

function emojiForZEvents (zEvents) {
  if (zEvents.includes('commandSuccess')) {
    return '✅';
  }

  if (zEvents.includes('commandNotFound')) {
    return '❓';
  }

  if (zEvents.includes('otherError')) {
    return '❌';
  }

  console.error('Unknown emojiForZEvents', zEvents);
  return '⁉️';
}

async function parseTopX (type, opts) {
  const tops = await UCHistory.topX(type, opts);
  const kvEd = {};
  for (let i = 0; i < tops.length; i += 2) {
    kvEd[tops[i]] = tops[i + 1];
  }
  return `Top "${type}" user commands:\n\n` + formatKVsWithOpts(kvEd, { sortByValue: true });
}

const SubCommands = {
  topSuccess: parseTopX.bind(null, 'commandSuccess'),
  topNotFound: parseTopX.bind(null, 'commandNotFound'),
  topError: parseTopX.bind(null, 'otherError'),
  topNetNotMatched: parseTopX.bind(null, 'netNotMatched')
};

async function ucHistory (context) {
  const cOpts = { ...UCHistory.QUERY_DEFAULTS, ...context.options };

  if (context.options._.length) {
    return SubCommands[context.options._[0]](cOpts);
  }

  const embed = new MessageEmbed()
    .setTitle('User Command History')
    .setDescription(
      `Showing the **${cOpts.limit} ${cOpts.latestFirst ? 'latest' : 'oldest'}** ` +
      'commands (not including this invocation), with the most-recent at the ' +
      `**${cOpts.sortAscending ? 'top' : 'bottom'}**.`
    );

  (await UCHistory.query(cOpts)).forEach(({
    command, setScoreTs, metadata: {
      zEvents, sentBy, sentIn: { channel }
    }
  }) => embed.addField(
    `At _${(new Date(setScoreTs)).toDRCString()}_ by **${sentBy}** in ${channel}:`,
    `${emojiForZEvents(zEvents)} \`${command}\`\n\n`
  ));

  context.sendToBotChan({ embeds: [embed] }, true);
}

ucHistory.__drcHelp = () => {
  return {
    title: 'Query user command execution history',
    usage: '[options] (subcommand)',
    notes: 'Queries the user\'s command execution history in various guises. Not all options apply to all subcommands.\n\n' +
      `Without any subcommands, returns the most-recent \`--limit\` (${UCHistory.QUERY_DEFAULTS.limit}) commands executed.`,
    options: [
      ['--limit', `The maximum amount of results to return. Default: ${UCHistory.QUERY_DEFAULTS.limit}`, true],
      ['--latestFirst', `Sort the results with the latest-in-time first. Default: ${UCHistory.QUERY_DEFAULTS.latestFirst}`, true],
      ['--sortAscending', `Sort the results in ascending primary order. Default: ${UCHistory.QUERY_DEFAULTS.sortAscending}`, true],
      ['--from', 'The oldest time from which to fetch messages', true],
      ['--to', 'The youngest time from which to fetch messages', true]
    ],
    subcommands: Object.entries(SubCommands).reduce((a, [k, v]) => ({
      [k]: {
        text: `Queries the top "${k.replace('top', '')}" commands`
      },
      ...a
    }), {})
  };
};

module.exports = ucHistory;
