'use strict';

const fs = require('fs');
const _ = require('lodash');
const path = require('path');
const dfns = require('date-fns');
const config = require('config');
const Redis = require('ioredis');
const readline = require('readline');
const { fetch } = require('undici');
const dns = require('dns').promises;
const shodan = require('shodan-client');
const parseDuration = require('parse-duration');

const PKGJSON = JSON.parse(fs.readFileSync('package.json'));
const VERSION = PKGJSON.version;
const NAME = PKGJSON.name;
const ENV = /* process.env.NODE_ENV || */ 'dev';
const PREFIX = [NAME, ENV].join('-');
const CTCPVersion = `${config.irc.ctcpVersionPrefix} v${VERSION} <${config.irc.ctcpVersionUrl}>`;

let resolverRev;

class JsonMapper {
  constructor (path, name, { createOnNotFound = true, createNetworksOnNotFound = false } = {}) {
    this._path = path;
    this._name = name;
    this._options = {
      createOnNotFound,
      createNetworksOnNotFound
    };

    this._resolve();
    this._load();
  }

  _resolve () {
    let resolvePath = this._path;

    if (process.env.NODE_ENV) {
      const pathComps = path.parse(this._path);
      this.path = path.resolve(path.join(pathComps.dir, `${pathComps.name}-${process.env.NODE_ENV}${pathComps.ext}`));

      try {
        this._load();
        resolvePath = this.path;
      } catch (err) {
        console.warn(`Failed to find ${this.path}: ${this._options.createOnNotFound ? 'creating!' : 'falling back to default!'}`);

        if (this._options.createOnNotFound) {
          resolvePath = this.path;
          fs.writeFileSync(this.path, JSON.stringify({}));
        } else {
          resolvePath = this._path;
        }
      }
    }

    this.path = path.resolve(resolvePath);
    console.log(`${this._name} resolved config file path to: ${this.path}`);
  }

  _load () {
    this.cache = JSON.parse(fs.readFileSync(this.path));
  }

  async _mutate (network, key, value) {
    if (!this.cache[network]) {
      if (!this._options.createNetworksOnNotFound) {
        return null;
      }

      this.cache[network] = {};
    }

    const net = this.cache[network];

    if (value) {
      net[key] = value;
    } else {
      if (!net[key]) {
        return null;
      }

      delete net[key];
    }

    return fs.promises.writeFile(this.path, JSON.stringify(this.cache, null, 2));
  }

  forNetwork (network) {
    this._load();

    if (this.cache[network]) {
      return _.cloneDeep(this.cache[network]);
    }

    return {};
  }

  findNetworkForKey (key) {
    this._load();
    return Object.entries(this.cache).find(([, netMap]) => Object.entries(netMap).find(([k]) => k === key))?.[0] ?? {};
  }

  async set (network, key, value) {
    return this._mutate(network, key, value);
  }

  async remove (network, key) {
    return this._mutate(network, key, null);
  }
}

const ChannelXforms = new JsonMapper(config.irc.channelXformsPath, 'ChannelXforms');
const PrivmsgMappings = new JsonMapper(config.irc.privmsgMappingsPath, 'PrivmsgMappings', {
  createNetworksOnNotFound: true
});

function resolveNameForIRC (network, name) {
  ChannelXforms._load();
  const xforms = ChannelXforms.cache[network];
  console.debug('resolveNameForIRC', network, name, xforms);
  return (xforms && xforms[name]) || name;
}

function resolveNameForDiscord (network, ircName) {
  ChannelXforms._load();
  if (!resolverRev) {
    resolverRev = Object.entries(ChannelXforms.cache).reduce((a, [network, nEnt]) => {
      return { [network]: Object.entries(nEnt).reduce((b, [k, v]) => ({ [v]: k, ...b }), {}), ...a };
    }, {});
  }

  return ((network && ircName && (resolverRev && resolverRev[network] &&
    resolverRev[network][ircName.toLowerCase().slice(1)])) || ircName.replace(/^#/, '')).toLowerCase();
}

function channelsCountProcessed (channels, prev, durationInS) {
  return Object.entries(channels).reduce((a, [ch, count]) => {
    const [_, net, chan] = ch.split(':'); // eslint-disable-line no-unused-vars
    if (!a[net]) {
      a[net] = [];
    }

    let suffix = '';
    let suffixFields = {};
    if (prev && prev[ch]) {
      const delta = count - prev[ch];
      const mpm = Number((delta / durationInS) * 60);
      suffix += delta ? ` (+${delta}${durationInS ? `, ${mpm.toFixed(1)}mpm` : ''})` : ' (_nil_)';
      suffixFields = { delta, mpm };
    }

    const discordName = resolveNameForDiscord(net, '#' + chan);
    a[net].push({
      count,
      network: net,
      channel: {
        ircName: chan,
        discordName
      },
      msg: `\t**${count}** in **#${discordName}**${suffix}`,
      ...suffixFields
    });
    return a;
  }, {});
}

function channelsCountToStr (channels, prev, durationInS, sortByMpm) {
  const mapped = channelsCountProcessed(channels, prev, durationInS);

  let sorter = (a, b) => b.count - a.count;

  if (sortByMpm) {
    sorter = (a, b) => b.mpm - a.mpm;
  }

  const chanStrsMapped = (chanStrs) => chanStrs
    .sort(sorter)
    .slice(0, config.app.statsTopChannelCount)
    .map(x => x.msg)
    .join('\n');

  return Object.entries(mapped).reduce((a, [net, chanStrs]) => (
    a + `**Network**: \`${net}\`\n_\t(Top ${config.app.statsTopChannelCount} ` +
    `of ${chanStrs.length}${sortByMpm ? ', sorted by mpm' : ''})_\n${chanStrsMapped(chanStrs)}\n`
  ), '');
}

async function floodProtect (ops, ...args) {
  for (const op of ops) {
    await new Promise((resolve, reject) => {
      setTimeout(async () => {
        try {
          resolve(await op(...args));
        } catch (e) {
          reject(e);
        }
      }, config.irc.floodProtectWaitMs);
    });
  }
}

function fmtDuration (start, allowSeconds, end = new Date()) {
  if (typeof start === 'string') {
    start = dfns.parseISO(start);
  }

  const defOpts = ['years', 'months', 'weeks', 'days', 'hours', 'minutes'];

  if (allowSeconds) {
    defOpts.push('seconds');
  }

  const options = { format: defOpts };
  const fmt = () => dfns.formatDuration(dfns.intervalToDuration({ start, end }), options);
  let dur = fmt();

  if (!dur) {
    options.format.push('seconds');
    dur = fmt();
  }

  if (dur.match(/days/)) {
    options.format.pop();
    dur = fmt();
  }

  return dur;
}

async function shodanApiInfo () {
  const apiKey = config.shodan.apiKey || process.env.SHODAN_API_KEY;

  if (!apiKey) {
    return;
  }

  return shodan.apiInfo(apiKey);
}

async function shodanHostLookup (host) {
  const apiKey = config.shodan.apiKey || process.env.SHODAN_API_KEY;

  if (!apiKey) {
    return;
  }

  try {
    return await shodan.host(host, apiKey);
  } catch (e) {
    if (e.message.indexOf('Invalid IP') !== -1) {
      const resolved = await shodan.dnsResolve(host, apiKey);

      if (resolved[host]) {
        return shodanHostLookup(resolved[host]);
      } else {
        e = new Error(`unable to resolve ${host}`); // eslint-disable-line no-ex-assign
      }
    }

    return {
      error: {
        message: e.message,
        stack: e.stack
      }
    };
  }
}

// for the record i'm annoyed that using exceptions for control flow here
// is easier so i'm doing it, but it is so ia m

class AmbiguousMatchResultError extends Error {
  constructor (msg) {
    super(msg);
    this.name = this.constructor.name;
  }
}

class NetworkNotMatchedError extends Error {
  constructor (msg) {
    super(msg);
    this.name = this.constructor.name;
  }
}

function matchNetwork (network, options = { returnScores: false }) {
  const ret = {};

  if (!config.irc.registered[network]) {
    const scored = Object.keys(config.irc.registered)
      .map(rn => [rn.indexOf(network), rn])
      .filter(x => x[0] !== -1)
      .sort((a, b) => a[0] - b[0]);

    if (scored.length && scored[0].length) {
      if (scored.length > 1 && scored[0][0] === scored[1][0]) {
        throw new AmbiguousMatchResultError(network, ' -- Scores: ' + JSON.stringify(scored));
      }

      network = scored[0][1];

      if (options.returnScores) {
        ret.scores = scored;
      }
    } else {
      throw new NetworkNotMatchedError(network);
    }
  }

  return { network, ...ret };
}

function parseRedisInfoSection (section) {
  const lines = section.split(/\r?\n/g);

  if (!lines[0][0] === '#') {
    throw new Error('malformed section', lines);
  }

  const sectionName = lines[0].split(/\s+/)[1];
  lines.shift();
  lines.pop();

  return {
    sectionName,
    kvPairs: lines.reduce((a, line) => ({
      [line.split(':')[0]]: line.split(':')[1],
      ...a
    }), {})
  };
}

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

function isIpAddress (ip) {
  return ip.match(/^(?:\d{1,3}\.){3}\d{1,3}$/) !== null;
}

async function ipInfo (ipOrHost) {
  if (!config.ipinfo.token) {
    return null;
  }

  let ip = ipOrHost;
  if (!isIpAddress(ip)) {
    try {
      ip = (await dns.lookup(ipOrHost)).address;
    } catch (err) {
      console.warn(`Lookup for "${ip} failed: ${err.message}`);
      return null;
    }
  }

  const res = await fetch(`https://ipinfo.io/${ip}`, {
    headers: {
      Authorization: `Bearer ${config.ipinfo.token}`
    }
  });

  if (!res.ok) {
    console.warn(`ipinfo.io lookup for "${ip}" failed (${res.status})`, res);
    return null;
  }

  return res.json();
}

const getLogsFormats = {
  json: (x) => x,
  txt: (x) => `[${new Date(x.__drcIrcRxTs).toISOString()}] <${x.nick}> ${x.message}`
};

async function getLogs (network, channel, { from, to, format = 'json', filterByNick } = {}) {
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

  const [fromTime, toTime] = [from, to].map(x => {
    const chkDate = new Date(x);

    if (chkDate.toString() === 'Invalid Date') {
      const parsed = parseDuration(x);

      if (parsed) {
        return Number(new Date()) + parsed;
      }

      return undefined;
    }

    return chkDate;
  });

  const expectedPath = path.resolve(path.join(logCfg.path, network, channel));
  let rl;
  try {
    rl = readline.createInterface({ input: fs.createReadStream(expectedPath) });
  } catch (e) {
    console.error(`Logs failed to open ${expectedPath}`, e);
    return;
  }

  const retList = [];
  let lc = 1;

  for await (const line of rl) {
    try {
      const pLine = JSON.parse(line);

      if (!pLine.__drcIrcRxTs) {
        throw new Error('missing __drcIrcRxTs');
      }

      const tsDate = new Date(pLine.__drcIrcRxTs);

      if ((fromTime && tsDate < fromTime) || (toTime && tsDate > toTime)) {
        continue;
      }

      if (filterByNick && !filterByNick.includes(pLine.nick)) {
        continue;
      }

      retList.push(formatter(pLine));
    } catch (e) {
      console.debug(`getLogs(${network}, ${channel})> failed parse ${expectedPath}:${lc}, "${e.message}":`, line);
    } finally {
      lc++;
    }
  }

  return retList;
}

const checkValAgainst_regexCache = {}; // eslint-disable-line camelcase

function checkValAgainst (opt, field) {
  if (opt.indexOf('/') === 0) {
    const closingIdx = opt.slice(1).indexOf('/') + 1;

    if (closingIdx < 1) {
      throw new Error(`bad regex spec "${opt}"`);
    }

    if (!checkValAgainst_regexCache[opt]) {
      const flags = opt.slice(closingIdx + 1);
      const reExtract = opt.slice(1, -(opt.length - closingIdx));
      checkValAgainst_regexCache[opt] = new RegExp(reExtract, flags);
      console.log('CACHED RE for key', opt, checkValAgainst_regexCache[opt]);
    }

    return field.match(checkValAgainst_regexCache[opt]) !== null;
  }

  return field.indexOf(opt) !== -1;
}

function findFixedNonZero (num, depth = 1, maxDepth = 10) {
  if (depth === maxDepth) {
    return Number(num).toFixed(depth);
  }

  const chk = Number(num).toFixed(depth);
  return Number(chk) ? chk : findFixedNonZero(num, depth + 1);
}

async function searchLogs (network, options) {
  const logCfg = config.irc.log;

  if (!logCfg || !logCfg.channelsToFile) {
    return null;
  }

  const expectedPath = path.resolve(path.join(logCfg.path, network));
  let networkFiles = (await fs.promises.readdir(expectedPath, { withFileTypes: true }))
    .filter((fEnt) => fEnt.isFile());

  if (!options.everything) {
    networkFiles = networkFiles.filter((fEnt) => fEnt.name.indexOf('#') === 0);
  }

  if (!options.nick && !options.message) {
    console.error(options);
    throw new Error('no search option given');
  }

  let totalLines = 0;
  const searchResults = Object.fromEntries((await Promise.all(networkFiles.map((f) => new Promise((resolve) => {
    getLogs(network, f.name, options).then((logLines) => resolve([f.name, logLines]));
  }))))
    .map(([channel, lines]) => {
      totalLines += lines.length;

      return [channel, lines.filter((l) => {
        if (options.nick && !checkValAgainst(options.nick, l.nick)) {
          return false;
        }

        if (options.message && !checkValAgainst(options.message, l.message)) {
          return false;
        }

        return true;
      })];
    })
    .filter(([, lines]) => !!lines.length));

  return { totalLines, searchResults };
}

// ref: https://modern.ircdocs.horse/formatting.html#characters
const ircEscapeXforms = Object.freeze({
  '\x02': '**',
  '\x1d': '_',
  '\x1f': '__',
  '\x1e': '~',
  '\x11': '`'
});

const IRCColorsStripMax = 16;

// the following aren't supported by us, so we just strip them
const ircEscapeStripSet = Object.freeze([
  ...Buffer.from(Array.from({ length: IRCColorsStripMax }).map((_, i) => i)).toString().split('').map(x => `\x03${x}`), // colors
  ...Array.from({ length: 10 }).map((_, i) => i).map(x => `\x030${x}`),
  ...Array.from({ length: 7 }).map((_, i) => i).map(x => `\x03${x + 10}`),
  '\x16', // reverse color
  '\x0f' // reset; TODO, some bots have been seen to use this byte to reset standard escapes (defined in ircEscapeXforms above)... need to handle this
  /*
  2022-01-07T09:42:51.833Z <drc/0.2/discord/debug> replaceIrcEscapes S> "Title: Python Sudoku Solver - Computerphile "
  00000000: 0254 6974 6c65 0f3a 2050 7974 686f 6e20 5375 646f 6b75 2053 6f6c 7665 7220 2d20   .Title.: Python Sudoku Solver -
  00000020: 436f 6d70 7574 6572 7068 696c 6520                                                Computerphile
  2022-01-07T09:42:51.834Z <drc/0.2/discord/debug> replaceIrcEscapes E> "**Title: Python Sudoku Solver - Computerphile "
  00000000: 2a2a 5469 746c 653a 2050 7974 686f 6e20 5375 646f 6b75 2053 6f6c 7665 7220 2d20   **Title: Python Sudoku Solver -
  00000020: 436f 6d70 7574 6572 7068 696c 6520                                                Computerphile
  */
]);

const ircEscapeStripTester = new RegExp(`(${ircEscapeStripSet.join('|')})`);
const ircEscapeTester = new RegExp(`(${Object.keys(ircEscapeXforms).join('|')})`);

function replaceIrcEscapes (message) {
  let hit = false;
  const orig = message;

  if (message.match(ircEscapeStripTester)) {
    hit = true;
    message = ircEscapeStripSet.reduce((m, esc) => m.replaceAll(esc, ''), message);
    // *after* stripping multi-byte combinations, strip any remaining color start codes (0x03)
    message = message.replaceAll(/\x03/g, ''); // eslint-disable-line no-control-regex
  }

  if (message.match(ircEscapeTester)) {
    hit = true;
    message = Object.entries(ircEscapeXforms).reduce((m, [esc, repl]) => m.replaceAll(esc, repl), message);
  }

  if (hit) {
    console.debug(`replaceIrcEscapes S> "${orig}"\n` + xxd(orig));
    console.debug(`replaceIrcEscapes E> "${message}"\n` + xxd(message));
  }

  return message;
}

const xxdSplitter = /([a-f0-9]{4})/;
const unprintables = /[^ -~]+/g;

function xxd (buffer, { rowWidth = 32, returnRawLines = false } = {}) {
  if (!(buffer instanceof Buffer)) {
    try {
      buffer = Buffer.from(buffer);
    } catch (err) {
      console.debug('xxd error', err);
      return;
    }
  }

  const retLines = [];
  for (let startOff = 0; startOff < buffer.length; startOff += rowWidth) {
    const curChunk = buffer.subarray(startOff, startOff + rowWidth);
    retLines.push(
      startOff.toString(16).padStart(8, '0') + ': ' +
      curChunk.toString('hex').split(xxdSplitter).filter(x => x.length).join(' ').padEnd(rowWidth * 2 + ((rowWidth / 2) + 1)) + ' ' +
      curChunk.toString().replace(unprintables, '.')
    );
  }

  return returnRawLines ? retLines : retLines.join('\n');
}

function expiryDurationFromOptions (options) {
  return (options.ttl ? options.ttl * 60 : config.http.ttlSecs) * 1000;
}

function expiryFromOptions (options) {
  return Number(new Date()) + expiryDurationFromOptions(options);
}

async function scopedRedisClient (scopeCb) {
  const scopeClient = new Redis(config.redis.url);
  const retVal = await scopeCb(scopeClient);
  await scopeClient.disconnect();
  return retVal;
}

module.exports = {
  ircEscapeStripSet,
  ENV,
  NAME,
  PREFIX,
  VERSION,
  CTCPVersion,
  IRCColorsStripMax,

  ChannelXforms,
  PrivmsgMappings,

  resolveNameForIRC,
  resolveNameForDiscord,
  channelsCountProcessed,
  channelsCountToStr,
  floodProtect,
  fmtDuration,
  shodanHostLookup,
  shodanApiInfo,
  matchNetwork,
  parseRedisInfoSection,
  sizeAtPath,
  isIpAddress,
  ipInfo,
  getLogs,
  searchLogs,
  checkValAgainst,
  findFixedNonZero,
  replaceIrcEscapes,
  xxd,
  expiryFromOptions,
  expiryDurationFromOptions,
  scopedRedisClient,

  AmbiguousMatchResultError,
  NetworkNotMatchedError
};
