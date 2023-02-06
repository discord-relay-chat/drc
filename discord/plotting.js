'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const config = require('config');
const { hrtime } = require('process');
const { spawn } = require('child_process');
const { nanoid } = require('nanoid');
const { PREFIX, scopedRedisClient, runningInContainer } = require('../util');

async function _spawnGnuplotLocal (gnuplotCmds, tName, fName) {
  return new Promise((resolve, reject) => {
    const gnuplot = spawn('gnuplot');

    gnuplot.on('close', () => {
      fs.unlinkSync(tName);
      resolve({ data: { data: fName, error: null } });
    });

    gnuplot.on('error', reject);

    gnuplot.stdin.write(gnuplotCmds, 'utf8');
    gnuplot.stdin.end();

    gnuplot.stderr.on('data', (data) => {
      const trimmed = data.toString('utf8').trim();
      if (trimmed.length) {
        console.error('_spawnGnuplotLocal child stderr', trimmed);
      }
    });
  });
}

function plotMpmOutputFilename () {
  return (runningInContainer() ? '/http/static/' + config.app.stats.MPM_PLOT_FILE_NAME : config.app.stats.mpmPlotOutputPath);
}

async function plotMpmDataRender (data, maxY, {
  title = 'Messages per minute',
  timeUnit = 'hours',
  neverLogScale = true,
  alwaysLogScale = false,
  outPath = null,
  chatLinesColor = 'dark-turquoise',
  totalLinesColor = 'web-blue',
  asOfDate = null,
  produceBackupIfExtant = true
} = {}) {
  const fName = outPath || plotMpmOutputFilename();
  const tName = path.join(os.tmpdir(), `drc-mpmplot.${nanoid()}.dat`);
  await fs.promises.writeFile(tName, data.map(x => x.join(' ')).join('\n'));

  if (config.app.stats.plotBackupsAndGifGenerationEnabled && produceBackupIfExtant && fs.existsSync(fName)) {
    const { dir, base } = path.parse(fName);
    const isoDStr = (new Date()).toISOString().replaceAll(/[:.-]/g, '');
    const backupPath = path.join(dir, `${isoDStr}.${base}`);
    console.info(`Backing up current ${base} to ${backupPath}`);
    await fs.promises.writeFile(backupPath, await fs.promises.readFile(fName));

    if (base === config.app.stats.MPM_PLOT_FILE_NAME) {
      const toGifScriptPath = path.join(__dirname, '..', 'scripts', 'mpmplots-to-gif.sh');
      const toGifProc = spawn(toGifScriptPath, [dir]);
      toGifProc.on('close', () => console.log(`Finished ${toGifScriptPath}`));
      toGifProc.on('error', (e) => console.error(`${toGifScriptPath} errored`, e));
      toGifProc.stderr.on('data', (data) => console.error(`${toGifScriptPath} STDERR`, data.toString('utf8')));
      toGifProc.stdout.on('data', (data) => console.info(`${toGifScriptPath}:`, data.toString('utf8')));
    }
  }

  const xtics = [];
  const gapSize = Math.ceil(data.length / 10);
  for (let i = 0; i < data.length; i += gapSize) {
    xtics.push(`"${data[i][0]}" ${i}`);
  }

  let gnuplotCmds = ['set grid'];

  if (alwaysLogScale || (maxY > 100 && !neverLogScale)) {
    gnuplotCmds.push('set logscale y');
  }

  const plotLines = [`'${tName}' using 0:2 with filledcurve y1=0 lc rgb "${chatLinesColor}" title 'Chat'`];
  const totalTotalCol = data.reduce((a, [,, x]) => a + Number(x), 0);
  if (!Number.isNaN(totalTotalCol) && totalTotalCol !== 0) {
    plotLines.unshift(`'${tName}' using 0:3 with filledcurve y1=0 lc rgb "${totalLinesColor}" title 'Total'`);
  }

  gnuplotCmds = [
    ...gnuplotCmds,
    `set yrange [2:${Math.ceil(maxY * 1.05)}]`,
    'set tics nomirror',
    'set encoding utf8',
    'set label 2 "~" noenhanced', // doesn't do anything!
    `set xtics(${xtics.join(', ')})`,
    `set xlabel "← ${timeUnit} in the past • • • ${asOfDate ? asOfDate.toDRCString() : 'now'} →"`,
    'set grid x lt 1 lw .75 lc "gray40"',
    `set title "${title}\\nAs of {/:Bold ${(asOfDate ?? new Date()).toDRCString()}}" textcolor rgb "white"`,
    'set border lw 3 lc rgb "white"',
    'set xlabel textcolor rgb "white"',
    'set ylabel textcolor rgb "white"',
    'set key Left left reverse box samplen 2 width 2',
    'set key textcolor rgb "white"',
    'set terminal pngcairo notransparent enhanced font "helvetica, 11" fontscale 1.0',
    'set terminal pngcairo background "black"',
    `set output '${fName}'`,
    'set style fill transparent solid 0.6 noborder',
    'plot ' + plotLines.join(', ')
  ].join('\n');

  console.debug('gnuplotCmds:\n', gnuplotCmds);

  return _spawnGnuplotLocal(gnuplotCmds, tName, fName);
}

async function plotMpmData (timeLimitHours = config.app.stats.mpmPlotTimeLimitHours, overrideData, plotOpts) {
  if (!config.app.stats.plotEnabled) {
    return { data: { error: 'Plotting is not enabled' } };
  }

  let maxY = 0;
  let data = overrideData;
  if (!data) {
    const nowNum = Number(new Date());
    const timeLimit = nowNum - timeLimitHours * 60 * 60 * 1000;
    // double it to be safe, in case config.app.statsSilentPersistFreqMins wasn't always what it is now
    const queryLim = (timeLimitHours / (config.app.statsSilentPersistFreqMins / 60)) * 2;
    const startTime = hrtime.bigint();
    data = (await scopedRedisClient((rc) => rc.lrange(`${PREFIX}:mpmtrack`, 0, queryLim)))
      .map(JSON.parse)
      .filter((x) => x.timestamp >= timeLimit)
      .map((x) => {
        maxY = Math.max(x.chatMsgsMpm, x.totMsgsMpm, maxY);
        return [Number((nowNum - x.timestamp) / (1000 * 60 * 60)).toFixed(1), x.chatMsgsMpm, x.totMsgsMpm];
      })
      .reverse();

    console.log(`plotMpmData: querying ${queryLim} elements & filtering into ${data.length} ` +
      `took ${(Number(hrtime.bigint() - startTime) / 1e6).toFixed(2)}ms ` +
      `(timeLimitHours=${timeLimitHours}, statsSilentPersistFreqMins=${config.app.statsSilentPersistFreqMins})`);
  } else {
    maxY = data.reduce((max, [, a, b]) => Math.max(max, a, b), 0);
  }

  if (data?.length) {
    return plotMpmDataRender(data, maxY, plotOpts);
  }

  return { data: { error: 'No data to render' } };
}

module.exports = {
  plotMpmData,
  plotMpmDataRender,
  plotMpmOutputFilename
};
