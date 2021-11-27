function f (context) {
  const [cmd] = context.options._

  const reReq = require('../userCommands')

  let toSend
  if (cmd && reReq.__functions[cmd]) {
    const helpFunc = reReq.__functions[cmd].__drcHelp

    if (!helpFunc) {
      throw new Error(`no __drcHelp defined for "${cmd}"`)
    }

    toSend = '```\n' + helpFunc(context) + '\n```'
  }

  if (!toSend) {
    toSend = '_Available commands (`!help [command]` for help with `command`)_: **' + Object.keys(reReq.__functions).sort().join('**, **') + '**\n'
  }

  context.sendToBotChan(toSend)
}

f.__drcHelp = (context) => {
  return 'This help! Use "!help [command]" to get detailed help with "command"'
}

module.exports = f
