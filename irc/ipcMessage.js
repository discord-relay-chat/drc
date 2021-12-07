'use strict'

const config = require('config')
const Redis = require('ioredis')
const { spawn } = require('child_process')
const { PREFIX, resolveNameForIRC, floodProtect } = require('../util')

let haveJoinedChannels = false
const children = {}

module.exports = async (context, chan, msg) => {
  let {
    connectedIRC,
    msgHandlers,
    specServers,
    categories,
    chanPrefixes,
    stats
  } = context

  const pubClient = new Redis(config.redis.url)
  console.debug('Redis msg!', chan, msg)

  try {
    const parsed = JSON.parse(msg)

    // returns an async function if pushTarget is null, otherwish pushes that function
    // onto pushTarget and returns an object detailing the channel specification
    const getChannelJoinFunc = (pushTarget = null, serverSpec, chan) => {
      const botClient = connectedIRC.bots[serverSpec.name]

      if (!botClient) {
        throw new Error(`!botClient ${serverSpec.name}`)
      }

      const resName = resolveNameForIRC(serverSpec.name, chan.name)
      const ircName = `#${resName}`
      const channel = [PREFIX, serverSpec.name, resName, chan.id].join(':')
      const chanSpec = { channel, name: chan.name, ircName, id: chan.id, __drcNetwork: serverSpec.name }

      if (!msgHandlers[serverSpec.name]) {
        msgHandlers[serverSpec.name] = {}
      }

      const serverMsgHandlers = msgHandlers[serverSpec.name]
      if (serverMsgHandlers[channel]) {
        throw new Error(`channel ${chan.name} on ${serverSpec.name} is already joined!`)
      }

      const retFunc = async () => {
        const ircName = `#${resName}`
        const chanPubClient = new Redis(config.redis.url)
        const chanObj = botClient.channel(ircName)
        serverMsgHandlers[ircName] = { resName, channel, chanPubClient }
        console.debug(`${ircName} HANDLER REG`, resName, channel)

        console.log(`Joining ${ircName} (${chan.name}) (mapped to ${chan.id}) on ${serverSpec.name}: ${channel}`)
        const joinRes = chanObj.join(ircName)
        console.log('joinRes', joinRes)

        return new Promise((resolve) => {
          chanObj.updateUsers(async (channel) => {
            console.log(`Joined ${ircName}, it has ${channel.users.length} users`)
            // console.debug('!! CHANNEL USERS !!', channel.users)
            chanSpec.userCount = channel.users.length
            chanSpec.operators = channel.users.filter(x => x.modes.includes('o')).map(x => x.nick)

            const newPubC = new Redis(config.redis.url)
            await newPubC.publish(PREFIX, JSON.stringify({
              type: 'irc:channelJoined',
              data: chanSpec
            }))
            newPubC.disconnect()

            resolve(chanSpec)
          })
        })
      }

      if (!pushTarget) {
        return retFunc
      } else {
        pushTarget.push(retFunc)
        return chanSpec
      }
    }

    const discordChannelsHandler = async (isReconnect) => {
      if (Object.entries(specServers).length) {
        console.error('Rx\'ed discord:channels but servers are already speced!', specServers)
        return
      }

      const { categoriesByName } = parsed.data
      categories = context.categories = parsed.data.categories

      Object.entries(connectedIRC.bots).forEach(([server, client]) => {
        if (categoriesByName[server]) {
          const id = categoriesByName[server]
          specServers[server] = {
            id,
            name: server,
            spec: categories[id],
            channels: []
          }
        }
      })

      console.debug('SPEC SERVERS NOW', specServers)

      Object.entries(categories).forEach(([catId, category]) => {
        console.debug('HAVE CAT', catId, category.name, category)
        Object.entries(category.channels).forEach(([id, chanEnt]) => {
          const { name } = chanEnt
          console.debug('HAVE CHAN', id, name, chanEnt)
          if (connectedIRC.bots[category.name]) {
            specServers[category.name].channels.push({ name, id, parent: chanEnt.parentId, parentId: chanEnt.parentId })
          }
        })
      })

      console.log('specServers', JSON.stringify(specServers, null, 2))

      for (const [_, serverSpec] of Object.entries(specServers)) { // eslint-disable-line no-unused-vars
        const botClient = connectedIRC.bots[serverSpec.name]

        if (!botClient) {
          throw new Error(`!botClient ${serverSpec.name}`)
        }

        console.log('Joining channels...')

        const joinFuncs = []
        chanPrefixes[serverSpec.name] = serverSpec.channels.map(getChannelJoinFunc.bind(null, joinFuncs, serverSpec), [])
        await floodProtect(joinFuncs)

        console.log(`Joined ${joinFuncs.length} channels on ${serverSpec.name}.`)
        console.debug('chanPrefixes for', serverSpec.name, chanPrefixes[serverSpec.name])

        await pubClient.publish(PREFIX, JSON.stringify({
          type: 'irc:joined',
          data: {
            network: serverSpec.name,
            channels: chanPrefixes[serverSpec.name]
          }
        }))

        if (isReconnect) {
          if (!haveJoinedChannels) {
            console.error('isReconnect but not !haveJoinedChannels!?')
          }

          console.debug('Emitting irc:ready from discordChannelsHandler with isReconnect: true', parsed)
          await pubClient.publish(PREFIX, JSON.stringify({ type: 'irc:ready', data: { isReconnect: true } }))
        }

        haveJoinedChannels = true
      }
    }

    if (parsed.type === 'discord:requestPing:irc') {
      const e = parsed.data
      const botClient = connectedIRC.bots[e.network]
      console.debug(`Pinging ${e.network}...`)
      botClient.ping(['drc', Number(new Date()).toString()].join('-'))
    } else if (parsed.type === 'discord:deleteChannel') {
      const e = parsed.data
      const botClient = connectedIRC.bots[e.network]
      botClient.part('#' + resolveNameForIRC(e.network, e.name))
      // XXX BUG!! have to remove this channel from appropriate structs!!!
    } else if (parsed.type === 'discord:requestJoinChannel:irc') {
      // this comes first to signal the discord bot that we've ACKed the message and are acting on it
      // there's still a race here though on the discord side: if our "irc:topic" is RX'ed BEFORE this
      // message it'll throw an exception because the RX of this message induces the mapping required for
      // "irc:topic" to be handled correctly...
      await pubClient.publish(PREFIX, JSON.stringify({ type: 'irc:responseJoinChannel', data: parsed.data }))
      const joinFunc = getChannelJoinFunc(null, categories[parsed.data.parentId], parsed.data)
      const chanPrefix = await joinFunc()
      chanPrefixes[categories[parsed.data.parentId].name].push(chanPrefix)
    } else if (parsed.type === 'discord:requestSay:irc') { // similar to 'irc:say' below; refactor?
      const e = parsed.data

      if (!e.network || !e.target || !e.message) {
        throw new Error('discord:requestSay:irc bad args ' + JSON.stringify(e))
      }

      const botClient = connectedIRC.bots[e.network]

      if (!botClient) {
        throw new Error('discord:requestSay:irc bad client ' + JSON.stringify(e))
      }

      botClient.say(e.target, e.message)
      await pubClient.publish(PREFIX, JSON.stringify({ type: 'irc:responseSay', success: true }))
    } else if (parsed.type === 'discord:requestPs:irc') {
      const data = Object.entries(children).reduce((a, [pid, { started, proc }]) => {
        return [{
          pid,
          started,
          args: proc.spawnargs,
          exec: proc.spawnfile
        }, ...a]
      }, [])

      await pubClient.publish(PREFIX, JSON.stringify({ type: 'irc:responsePs', data }))
    } else if (parsed.type === 'discord:requestWhois:irc') {
      const retObj = {}
      if (!parsed.data || !parsed.data.network || !parsed.data.nick) {
        retObj.error = 'Bad arguments'
      } else {
        const client = connectedIRC.bots[parsed.data.network]

        if (client) {
          // should probably use the callback to do all the delivery to the user but right now
          // the 'whois' event is wired up and that is taking care of the response to the user
          let whoisCallback = () => {}

          if (parsed.data.options.nmap) {
            whoisCallback = (whoisData) => {
              if (!whoisData.hostname) {
                // should check more here maybe?
                return
              }

              const collectors = { stdout: [], stderr: [] }
              let opts = ['nmap', ...config.nmap.defaultOptions]

              if (Array.isArray(parsed.data.options.nmap)) {
                opts = [...opts, ...parsed.data.options.nmap]
              }

              opts.push(whoisData.hostname)
              console.log('Initiaing: ' + opts.join(' '))
              const proc = spawn('sudo', opts)

              proc.stdout.on('data', (d) => collectors.stdout.push(d.toString('utf8')))
              proc.stderr.on('data', (d) => collectors.stderr.push(d.toString('utf8')))

              proc.on('close', async () => {
                const started = children[proc.pid].started
                delete children[proc.pid]

                console.log(`nmap of ${whoisData.hostname} finished`)

                const endClient = new Redis(config.redis.url)
                const stdout = collectors.stdout.join('\n')
                const stderr = collectors.stderr.join('\n')
                await endClient.publish(PREFIX, JSON.stringify({
                  type: 'irc:responseWhois:nmap',
                  data: {
                    whoisData,
                    started,
                    stdout,
                    stderr
                  }
                }))
                endClient.disconnect()
              })

              children[proc.pid] = {
                started: new Date(),
                proc
              }
            }
          }

          client.whois(parsed.data.nick, whoisCallback)
          retObj.success = true
        } else {
          retObj.error = 'Unknown network'
        }
      }

      if (retObj.error) {
        await pubClient.publish(PREFIX, JSON.stringify({ type: 'irc:responseWhois', data: retObj }))
      }
    } else if (parsed.type === 'discord:requestStats:irc') {
      await pubClient.publish(PREFIX, JSON.stringify({ type: 'irc:responseStats', stats }))
    } else if (parsed.type === 'irc:say') {
      const networkSpec = specServers[parsed.data.network.name]

      if (!networkSpec) {
        return
      }

      const botClient = connectedIRC.bots[networkSpec.name]

      if (botClient) {
        botClient.channel(`#${parsed.data.channel}`).say(parsed.data.message)
      } else {
        console.error('Bad SAY', parsed)
      }
    } else if (parsed.type === 'discord:channels') {
      await discordChannelsHandler(false)
    } else if (parsed.type === 'discord:startup') {
      if (!haveJoinedChannels) {
        console.log('Got discord:startup but !haveJoinedChannels, running startup sequence...')
        await discordChannelsHandler(true)
        return
      }

      if (!context.allowsBotReconnect()) {
        throw new Error('Bot attempted to reconnect but is disallowed!', parsed)
      }

      console.log('Bot reconnected!')
      console.debug('Emitting irc:ready from discord:startup handler with isReconnect: true', parsed)
      ++stats.discordReconnects
      await pubClient.publish(PREFIX, JSON.stringify({ type: 'irc:ready', data: { isReconnect: true } }))

      for (const [network, prefixes] of Object.entries(chanPrefixes)) {
        // replay each irc:channelJoined then irc:joined
        await floodProtect(prefixes.map(chanSpec => {
          return async () => {
            console.log('Replaying irc:channelJoined on', network, chanSpec)
            await pubClient.publish(PREFIX, JSON.stringify({
              type: 'irc:channelJoined',
              data: chanSpec
            }))
          }
        }))

        console.log('Replaying irc:joined for', network)
        console.debug('chanPrefixes', prefixes)
        await pubClient.publish(PREFIX, JSON.stringify({
          type: 'irc:joined',
          data: {
            network,
            channels: prefixes
          }
        }))
      }
    }
  } catch (e) {
    console.error('bad Redis msg', e, msg)
    ++stats.errors
  } finally {
    pubClient.disconnect()
  }
}
