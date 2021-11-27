'use strict'

const fs = require('fs')
const dfns = require('date-fns')
const config = require('config')
const shodan = require('shodan-client')

const PKGJSON = JSON.parse(fs.readFileSync('package.json'))
const VERSION = PKGJSON.version
const NAME = PKGJSON.name
const ENV = process.env.DRC_ENV || 'dev'
const PREFIX = [NAME, ENV].join('-')
const CTCPVersion = `${config.irc.ctcpVersionPrefix} v${VERSION} <${config.irc.ctcpVersionUrl}>`

let resolverRev

function resolveNameForIRC (network, name) {
  const xforms = config.irc && config.irc.channelXforms[network]
  return (xforms && xforms[name]) || name
}

function resolveNameForDiscord (network, ircName) {
  if (!resolverRev) {
    resolverRev = Object.entries(config.irc.channelXforms).reduce((a, [network, nEnt]) => {
      return { [network]: Object.entries(nEnt).reduce((b, [k, v]) => ({ [v]: k, ...b }), {}), ...a }
    }, {})
  }

  return ((network && ircName && (resolverRev && resolverRev[network] && resolverRev[network][ircName.toLowerCase().slice(1)])) || ircName.replace(/^#/, '')).toLowerCase()
}

function channelsCountProcessed (channels, prev, durationInS) {
  return Object.entries(channels).reduce((a, [ch, count]) => {
    const [_, net, chan] = ch.split(':') // eslint-disable-line no-unused-vars
    if (!a[net]) {
      a[net] = []
    }

    let suffix = ''
    let suffixFields = {}
    if (prev && prev[ch]) {
      const delta = count - prev[ch]
      const mpm = Number((delta / durationInS) * 60)
      suffix += delta ? ` (+${delta}${durationInS ? `, ${mpm.toFixed(1)}mpm` : ''})` : ' (_nil_)'
      suffixFields = { delta, mpm }
    }

    const discordName = resolveNameForDiscord(net, '#' + chan)
    a[net].push({
      count,
      network: net,
      channel: {
        ircName: chan,
        discordName
      },
      msg: `\t**${count}** in **#${discordName}**${suffix}`,
      ...suffixFields
    })
    return a
  }, {})
}

function channelsCountToStr (channels, prev, durationInS, sortByMpm) {
  const mapped = channelsCountProcessed(channels, prev, durationInS)

  let sorter = (a, b) => b.count - a.count

  if (sortByMpm) {
    sorter = (a, b) => b.mpm - a.mpm
  }

  const chanStrsMapped = (chanStrs) => chanStrs
    .sort(sorter)
    .slice(0, config.app.statsTopChannelCount)
    .map(x => x.msg)
    .join('\n')

  return Object.entries(mapped).reduce((a, [net, chanStrs]) => (
    a + `**Network**: \`${net}\`\n_\t(Top ${config.app.statsTopChannelCount} ` +
    `of ${chanStrs.length}${sortByMpm ? ', sorted by mpm' : ''})_\n${chanStrsMapped(chanStrs)}\n`
  ), '')
}

async function floodProtect (ops, ...args) {
  for (const op of ops) {
    await new Promise((resolve, reject) => {
      setTimeout(async () => {
        try {
          resolve(await op(...args))
        } catch (e) {
          reject(e)
        }
      }, config.irc.floodProtectWaitMs)
    })
  }
}

function fmtDuration (start) {
  if (typeof start === 'string') {
    start = dfns.parseISO(start)
  }

  const options = { format: ['years', 'months', 'weeks', 'days', 'hours', 'minutes'] }
  const fmt = () => dfns.formatDuration(dfns.intervalToDuration({ start, end: new Date() }), options)
  let dur = fmt()

  if (!dur) {
    options.format.push('seconds')
    dur = fmt()
  }

  if (dur.match(/days/)) {
    options.format.pop()
    dur = fmt()
  }

  return dur
}

async function shodanApiInfo () {
  const apiKey = config.shodan.apiKey || process.env.SHODAN_API_KEY

  if (!apiKey) {
    return
  }

  return shodan.apiInfo(apiKey)
}

async function shodanHostLookup (host) {
  const apiKey = config.shodan.apiKey || process.env.SHODAN_API_KEY

  if (!apiKey) {
    return
  }

  try {
    return await shodan.host(host, apiKey)
  } catch (e) {
    if (e.message.indexOf('Invalid IP') !== -1) {
      const resolved = await shodan.dnsResolve(host, apiKey)

      if (resolved[host]) {
        return shodanHostLookup(resolved[host])
      } else {
        e = new Error(`unable to resolve ${host}`) // eslint-disable-line no-ex-assign
      }
    }

    return {
      error: {
        message: e.message,
        stack: e.stack
      }
    }
  }
}

// for the record i'm annoyed that using exceptions for control flow here
// is easier so i'm doing it, but it is so ia m

class AmbiguousMatchResultError extends Error {
  constructor (msg) {
    super(msg)
    this.name = this.constructor.name
  }
}

class NetworkNotMatchedError extends Error {
  constructor (msg) {
    super(msg)
    this.name = this.constructor.name
  }
}

function matchNetwork (network, options = { returnScores: false }) {
  const ret = {}

  if (!config.irc.registered[network]) {
    const scored = Object.keys(config.irc.registered)
      .map(rn => [rn.indexOf(network), rn])
      .filter(x => x[0] !== -1)
      .sort((a, b) => a[0] - b[0])

    if (scored.length && scored[0].length) {
      if (scored.length > 1 && scored[0][0] === scored[1][0]) {
        throw new AmbiguousMatchResultError(network, ' -- Scores: ' + JSON.stringify(scored))
      }

      network = scored[0][1]

      if (options.returnScores) {
        ret.scores = scored
      }
    } else {
      throw new NetworkNotMatchedError(network)
    }
  }

  return { network, ...ret }
}

function parseRedisInfoSection (section) {
  const lines = section.split(/\r?\n/g)

  if (!lines[0][0] === '#') {
    throw new Error('malformed section', lines)
  }

  const sectionName = lines[0].split(/\s+/)[1]
  lines.shift()
  lines.pop()

  return {
    sectionName,
    kvPairs: lines.reduce((a, line) => ({
      [line.split(':')[0]]: line.split(':')[1],
      ...a
    }), {})
  }
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

  AmbiguousMatchResultError,
  NetworkNotMatchedError
}
