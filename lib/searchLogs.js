'use strict';

const fs = require('fs');
const path = require('path');
const config = require('config');
const sqlite3 = require('sqlite3');
const { fmtDuration, tryToParseADateOrDuration } = require('./fmtDuration');
const { queryBuilder } = require('./queryBuilder');
const { attachSentimentToMessages, averageSentiments } = require('./sentiments');

const SearchFileTypes = Object.freeze({
  sqlite: '.sqlite3'
});

const getLogsFormats = {
  json: (x) => x,
  txt: (x) => `[${new Date(x.__drcIrcRxTs).toISOString()}] <${x.nick}> ${x.message}`
};

function getLogsSetup (network, channel, { from, to, format = 'json', filterByNick } = {}) {
  const logCfg = config.irc.log;

  if (!logCfg || !logCfg.channelsToFile) {
    return null;
  }

  if (filterByNick && typeof filterByNick === 'string') {
    filterByNick = filterByNick.split(',');
  }

  const formatter = getLogsFormats[format];

  if (!formatter) {
    throw new Error(`bad format ${format}`);
  }

  const [fromTime, toTime] = [from, to].map(tryToParseADateOrDuration);
  const expectedPath = path.resolve(path.join(logCfg.path, network, channel));
  return {
    formatter,
    fromTime,
    toTime,
    expectedPath,
    filterByNick
  };
}

async function getLogsSqlite (network, channel, options) {
  let {
    fromTime,
    toTime,
    expectedPath
  } = getLogsSetup(network, channel, options);

  if (path.parse(expectedPath).ext === '') {
    expectedPath += SearchFileTypes.sqlite;
  }

  const [query, params] = queryBuilder(options, fromTime, toTime);
  const db = new sqlite3.Database(expectedPath);
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) {
        console.error(`This query failed: ${query}`);
        return reject(err);
      }

      resolve([channel.replace(SearchFileTypes.sqlite, ''), rows]);
    });
  });
}

async function searchLogsSqlite (network, networkFiles, options, singleProcFunc) {
  const searchResults = (await Promise.all(networkFiles.map((file) =>
    singleProcFunc(network, file.name, options)
      .catch((e) => {
        console.error(`Searching ${file.name} failed: `, e);
        return [file, []];
      }))))
    .reduce((a, [chan, rows]) => {
      if (!rows.length) {
        return a;
      }

      return { [chan]: rows, ...a };
    }, {}); // whyTF did I chose a map for this? a list of tuples was BETTER!

  return {
    totalLines: Object.values(searchResults).reduce((a, x) => a + x.length, 0),
    searchResults
  };
}

async function searchLogs (network, options, singleProcFunc = getLogsSqlite) {
  const logCfg = config.irc.log;

  if (!logCfg || !logCfg.channelsToFile) {
    return null;
  }

  const expectedPath = path.resolve(path.join(logCfg.path, network));
  const searchExt = SearchFileTypes?.[options.filetype] ?? '.sqlite3';
  let networkFiles = (await fs.promises.readdir(expectedPath, { withFileTypes: true }))
    .filter((fEnt) => fEnt.isFile() && fEnt.name.endsWith(searchExt));

  if (!options.everything) {
    networkFiles = networkFiles.filter((fEnt) => fEnt.name.indexOf('#') === 0);
  }

  let retObj;
  let sentiments;
  const start = new Date();
  try {
    console.debug('SEARCH LIST:', networkFiles.map(x => x.name).join(', '));
    retObj = await searchLogsSqlite(network, networkFiles, options, singleProcFunc);

    for (const [channel, messageList] of Object.entries(retObj.searchResults)) {
      sentiments = await attachSentimentToMessages(channel, messageList, sentiments, options);
    }

    sentiments = averageSentiments(sentiments);
  } catch (err) {
    console.error(`searchLogsSqlite(${network}) failed:`, err);
    retObj = { totalLines: 0, searchResults: [], error: err };
  }

  const end = new Date();
  const queryTimeMs = end - start;
  return {
    queryTimeMs,
    queryTimeHuman: fmtDuration(start, true, end),
    sentiments,
    ...retObj
  };
}

module.exports = {
  SearchFileTypes,
  getLogsSetup,
  searchLogs
};
