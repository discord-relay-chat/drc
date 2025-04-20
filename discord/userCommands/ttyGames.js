const config = require('config');
const { spawn } = require('child_process');

const active = {};

const WhitelistedGames = ['adventure'];

const WhitelistedGamesRunnerOpts = {
  adventure: { settleTimeMs: 200 }
};

async function newGame (gameName, context, ...a) {
  if (!WhitelistedGames.includes(gameName)) {
    return `Invalid game ${gameName}`;
  }

  const options = WhitelistedGamesRunnerOpts[gameName];
  const newGameId = Number(Math.floor(Math.random() * 2e16)).toString(16).substring(0, 4);
  const chanName = `${gameName}-${newGameId}`;
  const channel = await context.createGuildChannel(chanName, {
    topic: `\`${gameName}\` #${newGameId}, started ${new Date().toDRCString()}`
  });

  let sendPaged = (prefix, d) => {
    const dStr = d.toString('utf8');

    const maxLen = Math.floor(config.discord.maxMsgLength * 0.9);
    for (let idx = 0; idx < dStr.length; idx += maxLen) {
      channel.send(`${prefix}(_page ${Math.floor(idx / maxLen) + 1}_)` +
        '```' + dStr.substring(idx, idx + maxLen) + '```');
    }
  };

  if (options?.settleTimeMs) {
    const realSender = sendPaged;
    const timeoutHandles = {};
    const buffers = {};
    sendPaged = function sendPagedSettled (prefix, d) {
      clearTimeout(timeoutHandles[prefix]);
      buffers[prefix] = (buffers[prefix] ?? Buffer.alloc(0)) + d;
      timeoutHandles[prefix] = setTimeout(() => {
        const sendCopy = Buffer.from(buffers[prefix]);
        buffers[prefix] = Buffer.alloc(0);
        realSender(prefix, sendCopy);
      }, options.settleTimeMs);
    };

    await channel.send('_This game\'s output must be buffered, so it may take some time for each prompt to arrive._');
  }

  const proc = spawn(gameName);
  const gameEnd = () => {
    delete active[chanName];
    proc?.disconnect();
    channel.send('**The game has ended.**');
    if (config.user.destroyGameChannelsWhenDone) {
      channel.send('This channel will self-destruct in 1 minute...');
      setTimeout(() => channel.delete('Game ended.').catch(console.warn), 60 * 1000);
    }
  };

  proc.stdout.on('data', sendPaged.bind(null, ''));
  proc.stderr.on('data', sendPaged.bind(null, 'ERROR '));
  proc.on('close', gameEnd);
  context.registerChannelMessageHandler(channel.id, (d) => {
    if (gameName === 'zork' && d.content.indexOf('!') === 0) {
      // WHY IN TF does zork allow shelling out with the '!' prefix?!
      // I can't find _anything_ discussing this online, but it's definitely a thing!
      return;
    }

    proc.stdin.write(d.content + '\n');
  });

  active[chanName] = {
    gameName,
    started: new Date(),
    channel,
    proc
  };

  return `Your game of \`${gameName}\` has started in channel <#${channel.id}>. Enjoy!`;
}

async function gameRunner (context, ...a) {
  const [cmd] = context.options._;

  switch (cmd) {
    case 'new':
      return newGame(context.options._[1], context, ...a);
  }

  return Object.entries(active).reduce((a, [k, v]) => ({ [k]: { pid: v.proc.pid, started: v.started }, ...a }), {});
}

gameRunner.__drcHelp = () => ({
  title: 'Run text-based games in a dedicated channel',
  usage: 'new game_name',
  notes: 'Launches text-based games in dedicated Discord channels. Available games include: ' + WhitelistedGames.join(', '),
  subcommands: {
    new: {
      text: 'Start a new game session in a dedicated channel'
    }
  }
});

module.exports = gameRunner;
