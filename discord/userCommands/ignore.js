const { generateListManagementUCExport, clearSquelched, digest } = require('../common');

module.exports = generateListManagementUCExport('ignore', {
  _squelchMessage: async (context, ...a) => async (messageObj) => context.redis.lpush([context.key, 'squelch'].join(':'), JSON.stringify(messageObj)),

  numSquelched: async (context, ...a) => `Have ${(await context.redis.lrange([context.key, 'squelch'].join(':'), 0, -1)).length} sequelched messages on \`${context.network}\``,

  getSquelched: async (context, ...a) => {
    const msgs = (await context.redis.lrange([context.key, 'squelch'].join(':'), 0, -1)).map(JSON.parse).reverse();

    if (context.options && context.options.clear) {
      await clearSquelched(context);
    }

    context.sendToBotChan(`Have ${msgs.length} sequelched messages on ` +
      `\`${context.network}\`${context.options.clear ? ' (cleared!)' : ''}:`);

    if (msgs.length > 10) {
      context.sendToBotChan("That's too many messages! Use `digest` instead.");
      return;
    }

    msgs.forEach((msg) => {
      const e = msg.data;
      let eHead = '<';
      let eFoot = '>';

      if (e.type === 'action') {
        eHead = '* ';
        eFoot = '';
      }

      context.sendToBotChan(`Sequelched in **${e.target}** on \`${e.__drcNetwork}\` ` +
        `at \`${new Date(msg.timestamp).toDRCString()}\`:\n` +
        `${eHead}**${e.nick}**${eFoot} ${e.message}`);
    });
  },

  digest,
  clearSquelched
}, true);
