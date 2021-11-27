'use strict'

const _ = require('lodash')
const os = require('os')
const config = require('config')
const { execSync } = require('child_process')
const { MessageEmbed } = require('discord.js')
const { PREFIX, channelsCountToStr, channelsCountProcessed, fmtDuration, parseRedisInfoSection } = require('../../util')
const { servePage } = require('../common')
const { banner } = require('../figletBanners')

async function f (context) {
  const promise = new Promise((resolve, reject) => {
    const rejectTimeout = setTimeout(() => {
      // reject(new Error('stats timeout'))
      console.error('stats timed out, but NOT throwing!')
    }, config.app.timeout * 1000)

    context.registerOneTimeHandler('irc:responseStats', 'stats', async (data) => {
      clearTimeout(rejectTimeout)
      resolve(data)
    })
  })

  const { stats } = context

  if (context.options.reload) {
    const statsPersist = await context.redis.get([PREFIX, 'stats'].join(':'))
    console.debug('RELOAD STATS?', statsPersist)

    if (statsPersist) {
      console.debug('STATS RELOAD before', stats)
      Object.entries(JSON.parse(statsPersist)).forEach(([key, value]) => {
        stats[key] = value
      })
      console.debug('STATS RELOAD after', stats)
    }
  }

  await context.publish({ type: 'discord:requestStats:irc' })
  stats.irc = await promise

  stats.sinceLast.loadavg = os.loadavg()
  stats.sinceLast.memUsage = { free: os.freemem(), total: os.totalmem() }

  const quitsCt = stats.sinceLast.quits.length
  stats.sinceLast.quits = []

  const totalChatMsgs = Object.values(stats.messages.channels).reduce((a, x) => a + x, 0)
  const chatMsgsDelta = stats.messagesLastAnnounce.channels
    ? totalChatMsgs - Object.values(stats.messagesLastAnnounce.channels).reduce((a, x) => a + x, 0)
    : 0
  const durationInS = (new Date() - stats.lastAnnounce) / 1000
  const totMsgsDelta = stats.messages.total - stats.messagesLastAnnounce.total

  let systemUptime = execSync('uptime -p').toString().replace(/^up\s+/, '').replace(/,/g, '')

  if (systemUptime.match(/days/)) {
    systemUptime = systemUptime.replace(/\s*\d+\s+minutes/ig, '')
  }

  stats.redis = {
    clients: parseRedisInfoSection(await context.redis.info('clients')).kvPairs,
    memory: parseRedisInfoSection(await context.redis.info('memory')).kvPairs,
    server: parseRedisInfoSection(await context.redis.info('server')).kvPairs
  }

  const redisHours = Math.floor(stats.redis.server.uptime_in_seconds / 60 / 60)

  stats.lastCalcs = {
    quitsCt,
    totalChatMsgs,
    chatMsgsDelta,
    durationInS,
    totMsgsDelta,
    banner: await banner('Stats'),
    memoryAvailablePercent: Number((stats.sinceLast.memUsage.free / stats.sinceLast.memUsage.total) * 100).toFixed(2),
    lastAnnounceFormatted: fmtDuration(stats.lastAnnounce),
    uptimeFormatted: fmtDuration(stats.upSince),
    systemUptime,
    channelsCountsStr: channelsCountToStr(
      stats.messages.channels,
      stats.messagesLastAnnounce.channels,
      durationInS,
      !context.options.sortByCount
    ),
    channelsCountProcessed: channelsCountProcessed(
      stats.messages.channels,
      stats.messagesLastAnnounce.channels,
      durationInS
    ),
    lagAsEmbedFields: Object.entries(stats.irc.latency).map(([name, value]) => ({ name, value: value.toString(), inline: true })),
    redisHours,
    redisUptime: (stats.redis.server.uptime_in_days > 0 ? `${stats.redis.server.uptime_in_days} days ` : '') +
      (redisHours > 0 ? `${redisHours - (stats.redis.server.uptime_in_days * 24)} hour${redisHours > 1 ? 's' : ''} ` : '') +
      `${Math.floor((stats.redis.server.uptime_in_seconds / 60) - Math.floor(stats.redis.server.uptime_in_seconds / 60 / 60) * 60)} minutes`
  }

  console.debug('channelsCountProcessed', stats.lastCalcs.channelsCountProcessed)

  if (!context.options.silent && !context.options.reload) {
    const name = await servePage(context, context.stats, 'stats')
    const embed = new MessageEmbed()
      .setColor(config.app.stats.embedColors.main)
      .setTitle('System Stats')
      .setURL(`https://${config.http.fqdn}/${name}`)

    if (stats.errors > 0) {
      embed.addField('Bot ERRORS', `${stats.errors}`)
    }

    if (stats.irc.errors > 0) {
      embed.addField('IRC ERRORS', `${stats.irc.errors}`)
    }

    console.debug('STATS', stats)

    embed
      .addFields(
        { name: 'Bot uptime', value: stats.lastCalcs.uptimeFormatted, inline: true },
        { name: 'IRC uptime', value: stats.irc.uptime, inline: true },
        { name: 'System uptime', value: stats.lastCalcs.systemUptime, inline: true },
        { name: 'Memory available', value: stats.lastCalcs.memoryAvailablePercent + '%', inline: true },
        { name: 'Load averages', value: stats.sinceLast.loadavg.join(', '), inline: true }
      )
      .addFields(
        { name: 'Redis clients', value: stats.redis.clients.connected_clients.toString(), inline: true },
        { name: 'Redis memory (peak)', value: stats.redis.memory.used_memory_peak_human.toString(), inline: true }
      )
      .addField('Lag', '(_milliseconds_)')
      .addFields(...stats.lastCalcs.lagAsEmbedFields)
      .addField('Messaging', '(_counts_)')
      .addFields(
        { name: 'Total', value: `${Number(stats.messages.total).toLocaleString()}\n(+${totMsgsDelta}, ${Number((totMsgsDelta / durationInS) * 60).toFixed(1)}mpm)`, inline: true },
        { name: 'IRC Total', value: `${Number(totalChatMsgs).toLocaleString()}\n(+${chatMsgsDelta}, ${Number((chatMsgsDelta / durationInS) * 60).toFixed(1)}mpm)`, inline: true }
      )
      .setTimestamp()
      .setFooter(`Last calculated ${stats.lastCalcs.lastAnnounceFormatted} ago`)

    await context.sendToBotChan(embed, true)

    if (context.options.long) {
      Object.entries(stats.lastCalcs.channelsCountProcessed).forEach(([network, channels]) => {
        let total = 0
        const sorter = context.options.sortByCount ? (a, b) => b.count - a.count : (a, b) => b.mpm - a.mpm
        const fields = channels
          .sort(sorter)
          .map(chan => {
            total += chan.count
            return {
              name: '#' + chan.channel.discordName,
              value: `${Number(chan.count).toLocaleString()}${chan.delta && chan.mpm ? `\n(+${chan.delta}, ${Number(chan.mpm).toFixed(2)}mpm)` : ''}`,
              inline: true
            }
          })

        const embed = new MessageEmbed()
          .setColor(config.app.stats.embedColors.main)
          .setTitle('Channel counts for ' + network)
          .addFields(...fields)
          .setTimestamp()
          .setFooter(`Total: ${total}`)

        context.sendToBotChan(embed, true)
      })
    }
  }

  stats.lastAnnounce = new Date()
  stats.messagesLastAnnounce = JSON.parse(JSON.stringify(stats.messages))
  // ^ this is so awful, yet literally from MDN: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/assign#warning_for_deep_clone

  const statsCopy = _.cloneDeep(stats)
  delete statsCopy.errors
  delete statsCopy.upSince
  delete statsCopy.irc
  delete statsCopy.lastCalcs
  await context.redis.set([PREFIX, 'stats'].join(':'), JSON.stringify(statsCopy))
}

f.__drcHelp = () => {
  return '!stats [options]\n\nOptions:\n' +
    '   --silent   Just calculate, don\'t post anything.\n' +
    '   --long     Include additional embeds with channel count information.'
}

module.exports = f
