
const { PREFIX, matchNetwork } = require('../../util')

// here we actually _want_ the unparsed `a` instead of argObj! so both are needed
async function f (context, ...a) {
  if (a.length < 2) {
    throw new Error('not enough args')
  }

  const { network } = matchNetwork(a[0])

  await context.redis.publish(PREFIX, JSON.stringify({
    type: 'discord:requestSay:irc',
    data: {
      network,
      target: a[1],
      message: a.slice(2).join(' ')
    }
  }))
}

f.__drcHelp = () => {
  return '!msg network targetId message...'
}

module.exports = f
