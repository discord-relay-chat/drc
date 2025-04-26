'use strict';

const { shodanHostLookup, shodanApiInfo } = require('../../util');

async function shodan (context, ...a) {
  let data = await (a[0] === '-info' ? shodanApiInfo() : shodanHostLookup(a.shift()));

  if (!data) {
    data = { error: true };
  }

  console.debug('SHODAN RAW', data);

  await context.publish({
    type: 'discord:shodan:' + (a[0] === '-info' ? 'info' : 'host'),
    data
  });
}

shodan.__drcHelp = () => ({
  title: 'Perform Shodan lookups for hosts',
  usage: 'host_or_ip | -info',
  notes: 'Queries the Shodan API for information about the specified host or IP address. Use `-info` to display API account information.',
  options: []
});

module.exports = shodan;
