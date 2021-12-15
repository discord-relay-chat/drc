'use strict';

const { shodanHostLookup, shodanApiInfo } = require('../../util');

module.exports = async function (context, ...a) {
  let data = await (a[0] === '-info' ? shodanApiInfo() : shodanHostLookup(a.shift()));

  if (!data) {
    data = { error: true };
  }

  console.debug('SHODAN RAW', data);

  await context.publish({
    type: 'discord:shodan:' + (a[0] === '-info' ? 'info' : 'host'),
    data
  });
};
