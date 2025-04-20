const { scopedRedisClient } = require('../../util');

function reload (context, ...a) {
  context.sendToBotChan('Reloading user commands...');
  try {
    const oldScriptsContext = require('../userCommands')('scripts').reloading();
    require('../userCommands').__unresolve();
    require('../userCommands').init(true, oldScriptsContext)
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

reload.__drcHelp = () => ({
  title: 'Reload user commands and IRC message handlers',
  usage: '',
  notes: 'Refreshes all command handlers and IRC message handlers. Useful after making code changes.'
});

module.exports = reload;
