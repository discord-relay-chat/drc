const { scopedRedisClient } = require('../../util');

module.exports = function (context, ...a) {
  context.sendToBotChan('Reloading user commands...');
  try {
    require('../userCommands').__unresolve();
    require('../userCommands').init()
      .then(() =>
        context.sendToBotChan(`Reloaded ${Object.keys(require('../userCommands').__functions).length} user commands`)
      )
      .catch((e) => console.error('userCommands init failed', e));
  } catch (e) {
    console.error('Reload failed!', e);
    context.sendToBotChan(`Reload failed! ${e}\n\n` + '```\n' + e.stack + '\n```\n');
  }

  context.sendToBotChan('Reloading IRC message handlers...');
  context.registerOneTimeHandler('__c2::irc:reload', 'response', async (data) => {
    console.log('IRC RELOAD OK', data);
    context.sendToBotChan('IRC message handlers reloaded.');
  });

  scopedRedisClient(async (rc, pfx) => rc.publish(pfx + ':__c2::irc:reload', JSON.stringify({
    type: 'request'
  })));
};
