'use strict'

const config = require('config')
const irc = require('irc-framework')
const inq = require('inquirer')
const Redis = require('ioredis')
const redisClient = new Redis(config.redis.url)
const { PREFIX, CTCPVersion } = require('./util')
const ipcMessageHandler = require('./irc/ipcMessage')

require('./logger')('irc')

const connectedIRC = {
  bots: {},
  users: {}
}

const msgHandlers = {}

const stats = {
  upSince: new Date(),
  errors: 0,
  discordReconnects: 0,
  latency: {}
}

let allowsBotReconnect = false
const chanPrefixes = {}

const categories = {}

async function connectIRCClient (connSpec) {
  if (connSpec.account && !connSpec.account.password) {
    const { password } = await inq.prompt({
      type: 'password',
      name: 'password',
      message: `Enter nickserv password for ${connSpec.nick}@${connSpec.host}`
    })

    connSpec.account.password = password
  }

  const ircClient = new irc.Client()

  const regPromise = new Promise((resolve, reject) => {
    ircClient.on('registered', resolve.bind(null, ircClient))
  })

  ircClient.on('debug', console.debug)
  connSpec.version = CTCPVersion
  ircClient.connect(connSpec)
  return regPromise
}

async function main () {
  console.log(`${PREFIX} IRC bridge started.`)
  const pubClient = new Redis(config.redis.url)
  const specServers = {}

  redisClient.on('message', ipcMessageHandler.bind(null, {
    connectedIRC,
    msgHandlers,
    specServers,
    categories,
    chanPrefixes,
    stats,
    allowsBotReconnect: () => allowsBotReconnect
  }))

  await redisClient.subscribe(PREFIX)

  console.log('Connected to Redis.')
  console.log(`Connecting ${Object.entries(config.irc.registered).length} IRC networks...`)

  const readyData = []
  for (const [host, serverObj] of Object.entries(config.irc.registered)) {
    const { port, user } = serverObj

    if (!host || !port) {
      throw new Error('bad server spec', serverObj)
    }

    if (connectedIRC.bots[host]) {
      throw new Error('dupliate server spec', serverObj)
    }

    const spec = {
      host,
      port,
      ...user
    }

    console.log(`Connecting '${spec.nick}' to ${host}...`)
    connectedIRC.bots[host] = await connectIRCClient(spec);

    ['quit', 'reconnecting', 'close', 'socket close', 'kick', 'ban', 'join',
      'unknown command', 'channel info', 'topic', 'part', 'invited', 'tagmsg',
      'ctcp response', 'ctcp request', 'wallops', 'nick', 'nick in use', 'nick invalid',
      'whois', 'whowas', 'motd', 'info', 'help']
      .forEach((ev) => {
        connectedIRC.bots[host].on(ev, async (data) => {
          console.debug('<IRC EVENT>', ev, data)
          if (typeof data !== 'object') {
            console.warn('non-object data!', data)
            return
          }

          data.__drcNetwork = host

          await pubClient.publish(PREFIX, JSON.stringify({
            type: 'irc:' + ev.replace(/\s+/g, '_'),
            data
          }))
        })
      })

    connectedIRC.bots[host].on('pong', (data) => {
      console.debug('RAW PONG', data)
      const nowNum = Number(new Date())
      const splitElems = data.message.split('-')

      if (splitElems.length > 1) {
        const num = Number(splitElems[1])
        if (!Number.isNaN(num)) {
          stats.latency[host] = nowNum - num
          console.debug(`Got PONG for ${host} with ${splitElems}: latency = ${stats.latency[host]}ms`)

          if (splitElems[0].indexOf('drc') === 0) {
            pubClient.publish(PREFIX, JSON.stringify({
              type: 'irc:pong',
              data: {
                __drcNetwork: host,
                latencyToIRC: stats.latency[host],
                ...data
              }
            }))
          }
        }
      }
    })

    const noticePubClient = new Redis(config.redis.url)
    connectedIRC.bots[host].on('message', (data) => {
      data.__drcNetwork = host

      if (data.target === spec.nick || data.type === 'notice') {
        noticePubClient.publish(PREFIX, JSON.stringify({
          type: 'irc:notice',
          data
        }))
        return
      }

      const handler = msgHandlers[host][data.target.toLowerCase()]

      if (!handler) {
        return
      }

      const { resName, channel, chanPubClient } = handler

      if (!resName || !channel || !chanPubClient) {
        throw new Error('bad handler', resName, channel)
      }

      chanPubClient.publish(channel, JSON.stringify({
        type: 'irc:message',
        data
      }))
    })

    console.log(`Connected registered IRC bot user ${spec.nick} to ${host}`)
    readyData.push({ network: host, nickname: spec.nick })
  }

  process.on('SIGINT', async () => {
    for (const [hn, client] of Object.entries(connectedIRC.bots)) {
      console.log(`quitting ${hn}`)
      let res
      const prom = new Promise((resolve, reject) => { res = resolve })
      client.on('close', res)
      client.quit('Quit.')
      await prom
      console.log(`closed ${hn}`)
    }

    pubClient.publish(PREFIX, JSON.stringify({ type: 'irc:exit' }))
    console.log('Done!')
    process.exit()
  })

  console.log('Ready!')
  pubClient.publish(PREFIX, JSON.stringify({ type: 'irc:ready', data: { readyData } }))
  allowsBotReconnect = true
}

main()
