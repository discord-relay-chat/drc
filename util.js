'use strict';

const fs = require('fs');
const path = require('path');
const dfns = require('date-fns');
const config = require('config');
const readline = require('readline');
const { fetch } = require('undici');
const dns = require('dns').promises;
const shodan = require('shodan-client');

const PKGJSON = JSON.parse(fs.readFileSync('package.json'));
const VERSION = PKGJSON.version;
const NAME = PKGJSON.name;
const ENV = process.env.DRC_ENV || 'dev';
const PREFIX = [NAME, ENV].join('-');
const CTCPVersion = `${config.irc.ctcpVersionPrefix} v${VERSION} <${config.irc.ctcpVersionUrl}>`;

let resolverRev;

function resolveNameForIRC (network, name) {
  const xforms = config.irc && config.irc.channelXforms[network];
  return (xforms && xforms[name]) || name;
}

function resolveNameForDiscord (network, ircName) {
  if (!resolverRev) {
    resolverRev = Object.entries(config.irc.channelXforms).reduce((a, [network, nEnt]) => {
      return { [network]: Object.entries(nEnt).reduce((b, [k, v]) => ({ [v]: k, ...b }), {}), ...a };
    }, {});
  }

  return ((network && ircName && (resolverRev && resolverRev[network] && resolverRev[network][ircName.toLowerCase().slice(1)])) || ircName.replace(/^#/, '')).toLowerCase();
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

function fmtDuration (start) {
  if (typeof start === 'string') {
    start = dfns.parseISO(start);
  }

  const options = { format: ['years', 'months', 'weeks', 'days', 'hours', 'minutes'] };
  const fmt = () => dfns.formatDuration(dfns.intervalToDuration({ start, end: new Date() }), options);
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

async function getLogs (network, channel, fromTime, toTime, format = 'json', filterByNick) {
  const logCfg = config.irc.log;

  if (!logCfg || !logCfg.channelsToFile) {
    return null;
  }

  const formatter = getLogsFormats[format];

  if (!formatter) {
    throw new Error(`bad format ${format}`);
  }

  [fromTime, toTime] = [fromTime, toTime].map(x => x ? new Date(x) : undefined);

  const expectedPath = path.resolve(path.join(logCfg.path, network, channel));
  const rl = readline.createInterface({ input: fs.createReadStream(expectedPath) });
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
      console.error(`failed parse on line ${lc}, "${e.message}":`, line);
    } finally {
      lc++;
    }
  }

  return retList;
}

module.exports = {
  ENV,
  NAME,
  PREFIX,
  VERSION,
  CTCPVersion,

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

  AmbiguousMatchResultError,
  NetworkNotMatchedError
};
