'use strict';

const { scopedRedisClient } = require('../../util');
const { formatKVs } = require('../common');

let commandAliases = {};

function tryResolvingAlias (functionName) {
  const rxMatch = Object.entries(commandAliases)
    .filter(([k]) => k.match(/^\/.*\/$/))
    .map(([rx]) => [rx, functionName.match(new RegExp(rx.slice(1, -1)))])
    .filter(([, x]) => !!x)
    .map(([rxStr, matchObj]) => [rxStr, matchObj.slice(1)]);

  if (rxMatch.length) {
    const [[rxStr, firstMatch]] = rxMatch;
    const tmplString = commandAliases[rxStr];

    return tmplString.split('$')
      .reduce((a, s) => {
        const extractNum = s.match(/^(\d+)(.*)/);
        if (extractNum?.length > 1) {
          const checkNum = Number.parseInt(extractNum[1]);
          if (!Number.isNaN(checkNum) && checkNum > 0 && checkNum <= firstMatch.length) {
            return a + firstMatch[checkNum - 1] + (extractNum?.[2] ?? '');
          }
        }

        return a + s;
      });
  }

  return commandAliases[functionName];
}

const key = (p) => p + ':ucAliases';

async function loadAliases () {
  Object.entries(await scopedRedisClient(async (c, p) => c.hgetall(key(p))))
    .forEach(([k, v]) => (commandAliases[k] = v));
  return commandAliases;
}

async function manageAliases (options) {
  const [name, ...val] = options?._ ?? [];

  if ((!name && !val.length) && options?.clearAll) {
    commandAliases = {};
    return scopedRedisClient(async (c, p) => c.del(key(p)));
  }

  if (name && val.length) {
    const strVal = val.join(' ').replace(/^"(.*?)"$/, '$1');
    commandAliases[name] = strVal;
    await scopedRedisClient(async (c, p) => c.hset(key(p), name, strVal));
  }

  return scopedRedisClient(async (c, p) => {
    if (name) {
      if (options?.remove) {
        delete commandAliases[name];
      }

      return (options?.remove ? c.hdel.bind(c) : c.hget.bind(c))(key(p), name);
    }

    await loadAliases();
    if (options.doNotFormat) {
      return commandAliases;
    }

    return formatKVs(commandAliases);
  });
}

module.exports = {
  commandAliases,
  tryResolvingAlias,
  manageAliases,
  loadAliases
};
