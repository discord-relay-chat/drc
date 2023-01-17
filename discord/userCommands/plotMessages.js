'use strict';

const path = require('path');
const { nanoid } = require('nanoid');
const config = require('../../config');
const { userFirstSeen, userLastSeen, fmtDuration, searchLogs, runningInContainer } = require('../../util');
const { getNetworkAndChanNameFromUCContext } = require('../common');
const { plotMpmData } = require('../plotting');
const { MessageEmbed } = require('discord.js');

const DELAY_PER_DAY_MS = 100;
const delayer = async () => new Promise((resolve) => setTimeout(resolve, DELAY_PER_DAY_MS));

const jobQueue = [];
let currentlyRunningJob, serviceHandle;

async function plotNickMsgsOverTimeUserCommand (context) {
  const { network } = getNetworkAndChanNameFromUCContext(context);
  if (!network) {
    return `Can't determine network from "${network}"`;
  }

  const dispName = context.options.nick || context.options.ident || context.options.hostname;
  let lastFirstDiffDays, dateFirstSeen;
  let dateLastSeen = new Date();

  if (context.options.sinceLastSeen || context.options.fromLastSeen) {
    const [[, lastSeen]] = await userLastSeen(network, context.options);
    dateLastSeen = new Date(lastSeen);
  }

  if (context.options.maxDays) {
    lastFirstDiffDays = context.options.maxDays;
    dateFirstSeen = new Date(dateLastSeen - (lastFirstDiffDays * 24 * 60 * 60 * 1000));
  } else {
    const [[, firstSeen]] = await userFirstSeen(network, context.options);
    dateFirstSeen = new Date(firstSeen);
    lastFirstDiffDays = Math.ceil((dateLastSeen - dateFirstSeen) / 1000 / 60 / 60 / 24);
  }

  if (lastFirstDiffDays < 2) {
    return 'Not enough days to plot!';
  }

  console.log('dateFirstSeen', dateFirstSeen, 'dateLastSeen', dateLastSeen);
  context.sendToBotChan(`Plotting ${lastFirstDiffDays} days of messages from **${dispName === '%' ? 'anyone' : dispName}**`);

  const byDay = [];
  let curToDate = dateLastSeen;
  while (curToDate > dateFirstSeen) {
    const fromDate = new Date(curToDate - (24 * 60 * 60 * 1000));
    const ourOpts = Object.assign({ from: fromDate, to: curToDate }, context.options);
    const { totalLines, queryTimeMs } = await searchLogs(network, ourOpts);
    byDay.push([fromDate, curToDate, totalLines, queryTimeMs]);
    curToDate = fromDate;
    currentlyRunningJob.percentComplete = Number((byDay.length / lastFirstDiffDays) * 100).toFixed(2);
    await delayer();
  }

  const dataForPlot = byDay.reduce((a, [from,, lines]) => ([[
    Math.floor((dateLastSeen - from) / 1000 / 60 / 60 / 24), lines, 0
  ], ...a]), []);

  let title = `{/:Bold ${lastFirstDiffDays} days} of messages ` +
    (dispName === '%' ? '' : `from {/:Bold ${dispName.replace('~', '\\\\~')}} `) +
    `on {/:Bold ${network}`;

  if (context.options.channel) {
    title += `/${context.options.channel.replaceAll('%', '*')}`;
  }

  title += '}';

  const outFname = ['plotMessages', dispName.replaceAll(/[^A-Za-z0-9_]+/g, '_'), network, nanoid()].join('_') + '.png';
  console.log('plotNick dispName', dispName);

  const outPath = path.join(runningInContainer() ? '/http/static' : config.http.staticDir, outFname);
  console.log('plotNick outPath?', outPath);
  const { data: { error, data } } = await plotMpmData(null, dataForPlot, {
    chatLinesColor: 'web-blue',
    ...context.options,
    title,
    timeUnit: 'days',
    neverLogScale: !!(context.options.neverLogScale ?? true),
    outPath,
    asOfDate: context.options.sinceLastSeen ?? context.options.fromLastSeen ? dateLastSeen : null
  });

  if (error) {
    return error;
  }

  const { base } = path.parse(data);
  const files = [`https://${config.http.fqdn}/static/${base}`];
  const embed = new MessageEmbed()
    .setColor(config.app.stats.embedColors.main)
    .setTitle(title.replaceAll('{/:Bold ', '').replaceAll('}', ''))
    .setURL(files[0])
    .setImage(`attachment://${base}`);
  context.sendToBotChan({ embeds: [embed], files }, true);
  return `(_...plotting \`${currentlyRunningJob.commandStr}\` took ${fmtDuration(new Date() - byDay.reduce((a, [,,, x]) => a + x, 0), true)}_)`;
}

async function plotNickMsgsOverTimeUserCommandQueueServicer (context) {
  clearTimeout(serviceHandle), serviceHandle = null; // eslint-disable-line no-unused-expressions,no-sequences

  if (jobQueue.length) {
    const [[topOfQueue, commandStr]] = jobQueue;

    context.sendToBotChan(`Running plot job "\`${commandStr}\`"` +
      (jobQueue.length - 1 > 0 ? `(${jobQueue.length - 1} are waiting)` : '') + '...');

    currentlyRunningJob = {
      commandStr,
      percentComplete: 0,
      start: new Date()
    };

    try {
      context.sendToBotChan(await topOfQueue());
    } catch (e) {
      console.error(e);
      context.sendToBotChan(`Plot job \`${currentlyRunningJob.commandStr}\` failed: ${e.message}`);
    } finally {
      jobQueue.shift(); // never retry failed jobs
      currentlyRunningJob = null;
      serviceHandle = setTimeout(plotNickMsgsOverTimeUserCommandQueueServicer.bind(null, context), 0);
    }
  }
}

function plotNickMsgsOverTimeUserCommandQueueManager (context) {
  if (Object.keys(context.options).filter((k) => !['_', '$0'].includes(k)).length === 0) {
    let currentlyRunningStr = '';
    if (currentlyRunningJob) {
      currentlyRunningStr = `Current plot job (at ${currentlyRunningJob.percentComplete}% complete, ` +
        `${Number((new Date() - currentlyRunningJob.start) / 1000 / 60).toFixed(1)} minutes elapsed):\n` +
        `• \`${currentlyRunningJob.commandStr}\`\n\n`;
    }

    return currentlyRunningStr +
    (jobQueue.length <= (currentlyRunningStr === '' ? 0 : 1)
      ? 'No plot jobs queued.'
      : 'Queue:\n\n• `' + jobQueue.slice(currentlyRunningStr === '' ? 0 : 1)
        .map(([, commandStr]) => commandStr).join('`\n• `') + '`');
  }

  jobQueue.push([plotNickMsgsOverTimeUserCommand.bind(null, context), context.discordMessage.content]);

  if (jobQueue.length === 1 && !serviceHandle) {
    return plotNickMsgsOverTimeUserCommandQueueServicer(context);
  }

  return `Queued plot job behind ${jobQueue.length - 1} others`;
}

module.exports = plotNickMsgsOverTimeUserCommandQueueManager;
