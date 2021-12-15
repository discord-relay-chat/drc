module.exports = function (context, ...a) {
  context.sendToBotChan('Reloading user commands...');
  try {
    require('../userCommands').__unresolve();
    context.sendToBotChan(`Reloaded ${Object.keys(require('../userCommands').__functions).length} user commands`);
  } catch (e) {
    console.error('Reload failed!', e);
    context.sendToBotChan(`Reload failed! ${e}\n\n` + '```\n' + e.stack + '\n```\n');
  }
};
