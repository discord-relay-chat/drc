const config = require('config')
const { spawn } = require('child_process')

const active = {}

module.exports = async function (context, ...a) {
  const [cmd] = a

  switch (cmd) {
    case 'new':
    {
      const newGameId = Number(Math.floor(Math.random() * 2e16)).toString(16).substring(0, 4)
      const chanName = `zork-${newGameId}`

      const proc = spawn('zork')
      const channel = await context.createGuildChannel(chanName, {
        topic: `Zork game #${newGameId}, started ${new Date().toLocaleString()} (PID: ${proc.pid})`
      })

      const sendPaged = (prefix, d) => {
        const dStr = d.toString('utf8')

        const maxLen = Math.floor(config.discord.maxMsgLength * 0.9)
        for (let idx = 0; idx < dStr.length; idx += maxLen) {
          channel.send(`${prefix}(_page ${Math.floor(idx / maxLen) + 1}_)` +
            '```' + dStr.substring(idx, idx + maxLen) + '```')
        }
      }

      proc.stdout.on('data', sendPaged.bind(null, ''))
      proc.stderr.on('data', sendPaged.bind(null, 'ERROR '))
      context.registerChannelMessageHandler(channel.id, (d) => {
        if (d.content.match(/^\s*!(?:quit|exit|end)\s*$/)) {
          proc.disconnect()
          channel.send('Ending game!')
          return
        }

        proc.stdin.write(d.content + '\n')
      })

      active[chanName] = {
        started: new Date(),
        channel,
        proc
      }

      return '#' + chanName
    }
  }

  return Object.entries(active).reduce((a, [k, v]) => ({ [k]: { pid: v.proc.pid, started: v.started }, ...a }), {})
}
