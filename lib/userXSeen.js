'use strict';

const sqlite3 = require('sqlite3');
const { SearchFileTypes, getLogsSetup, searchLogs } = require('./searchLogs');
const { queryBuilder } = require('./queryBuilder');

async function _userXSeen (network, options, isLast) {
  const opWord = isLast ? 'MAX' : 'MIN';
  const opCol = isLast ? options.max : options.min;
  const sorter = isLast ? (a, b) => b[1] - a[1] : (a, b) => a[1] - b[1];
  const op = `${opWord}(${opCol})`;

  const { totalLines, searchResults } = await searchLogs(network, options, async (network, channel, options) => {
    options.or = true;
    options.max = '__drcIrcRxTs';
    const { expectedPath } = getLogsSetup(network, channel, options);
    const [query, params] = queryBuilder(options);
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
  });

  if (totalLines > 0) {
    return Object.entries(searchResults)
      .filter(([, [{ [op]: max }]]) => Boolean(max))
      .map(([channel, [{ [op]: max }]]) => ([channel, max]))
      .sort(sorter)
      .map(([channel, max]) => ([channel, new Date(max).toDRCString()]));
  }

  return [];
}

async function userFirstSeen (network, options) {
  return _userXSeen(network, Object.assign({
    or: true,
    min: '__drcIrcRxTs'
  }, options), false);
}

async function userLastSeen (network, options) {
  return _userXSeen(network, Object.assign({
    or: true,
    max: '__drcIrcRxTs'
  }, options), true);
}

module.exports = {
  userFirstSeen,
  userLastSeen
};
