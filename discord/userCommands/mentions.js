'use strict'

const { PREFIX, matchNetwork } = require('../../util')
const { serveMessages } = require('../common')

module.exports = async function (context, ...a) {
  const [netStub] = a

  if (!netStub) {
    return 'Not enough arguments!'
  }

  const { network } = matchNetwork(netStub)
  context.network = network

  const luKey = [PREFIX, 'mentions', network, 'stream'].join(':')
  console.debug('MENTIONS', luKey, context.options)
  const allKeys = await context.redis.xrange(luKey, '-', '+')
  console.debug(allKeys)

  const allMsgKeys = allKeys.flatMap((idList) => idList.flatMap((ele) => ele[0] === 'message' ? ele[1] : null)).filter(x => !!x)
  console.debug(allMsgKeys)

  const allMsgs = []
  for (const msgKey of allMsgKeys) {
    allMsgs.push(JSON.parse(await context.redis.get(luKey + msgKey)))
  }

  console.debug(allMsgs)

  if (allMsgs.length) {
    serveMessages(context, allMsgs)
  } else {
    context.sendToBotChan('No messages')
  }
}
