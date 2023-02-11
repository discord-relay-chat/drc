'use strict';

const fs = require('fs');
const path = require('path');
const config = require('config');

const PKGJSON = JSON.parse(fs.readFileSync('package.json'));
const VERSION = PKGJSON.version;
const NAME = PKGJSON.name;
const ENV = process.env.NODE_ENV || 'dev';
const PREFIX = config.redis.prefixOverride || [NAME, ENV].join('-');
const CTCPVersion = config.irc.ctcpVersionOverride || `${config.irc.ctcpVersionPrefix} v${VERSION} <${config.irc.ctcpVersionUrl}>`;

// XXX axe
const scopedRedisClient = require('./lib/scopedRedisClient');

function runningInContainer () { return process.env.DRC_IN_CONTAINER; }

async function sizeAtPath (searchPath) {
  let a = 0;
  const curPathEles = await fs.promises.readdir(path.resolve(searchPath));

  for (const curPathEle of curPathEles) {
    const curPath = path.join(searchPath, curPathEle);
    const curStat = await fs.promises.stat(curPath);

    if (curStat.isDirectory()) {
      a += await sizeAtPath(curPath);
    } else if (curStat.isFile()) {
      a += curStat.size;
    }
  }

  return a;
}

function isObjPathExtant (obj, path) {
  if (typeof path === 'string') {
    if (path.search('.') === -1) {
      throw new Error(`isObjPathExtant: malformed path "${path}"`);
    }

    path = path.split('.');
  }

  if (obj[path[0]]) {
    const pathMut = Array.from(path);
    return isObjPathExtant(obj[pathMut.shift()], pathMut);
  }

  return !path.length ? obj : null;
}

function fqUrlFromPath (path) {
  return `${config.http.proto}://${config.http.fqdn}/${path}`;
}

Date.prototype.toDRCString = function () { // eslint-disable-line no-extend-native
  return this.toString().replace(/\sGMT.*/, '');
};

module.exports = {
  // XXX axe
  ...require('./lib/Errors'),
  ...require('./lib/Mappers'),
  ...require('./lib/channelsCount'),
  ...require('./lib/fmtDuration'),
  ...require('./lib/ipInfo'),
  ...require('./lib/matchNetwork'),
  ...require('./lib/nameResolvers'),
  ...require('./lib/replaceIrcEscapes'),
  scopedRedisClient,
  ...require('./lib/searchLogs'),
  ...require('./lib/shodan'),
  ...require('./lib/userXSeen'),

  ENV,
  NAME,
  PREFIX,
  VERSION,
  CTCPVersion,

  sizeAtPath,
  isObjPathExtant,
  fqUrlFromPath,
  runningInContainer
};
