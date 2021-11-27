'use strict'

const { matchNetwork } = require('../../util')
const { generateListManagementUCExport } = require('../common')
const { MessageMentions: { CHANNELS_PATTERN } } = require('discord.js')

const intCmds = {}

module.exports = function (context, ...a) {
  const [netStub, channelIdSpec] = context.options._
  const { network } = matchNetwork(netStub)

  if (!channelIdSpec.match(CHANNELS_PATTERN)) {
    throw new Error(`Bad channel ID spec ${channelIdSpec}`)
  }

  const [_, channel] = [...channelIdSpec.matchAll(CHANNELS_PATTERN)][0] // eslint-disable-line no-unused-vars

  const key = [network, channel].join('_')
  let cmdFunctor = intCmds[key]
  if (!cmdFunctor) {
    cmdFunctor = intCmds[key] = generateListManagementUCExport(`onJoin_${key}`)
  }

  context.options._[1] = context.options._[0]
  a[1] = a[0]
  context.options._.shift()
  a.shift()
  return cmdFunctor(context, ...a)
}
