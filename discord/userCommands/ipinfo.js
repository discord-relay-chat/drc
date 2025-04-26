'use strict';

const { ipInfo } = require('../../util');
const { formatKVs } = require('../common');

async function ipinfo (context) {
  if (!context.argObj._[0]) {
    return null;
  }

  return `\nIP info for **${context.argObj._[0]}**:\n` + formatKVs(await ipInfo(context.argObj._[0]));
}

ipinfo.__drcHelp = () => ({
  title: 'Retrieve information about an IP address',
  usage: 'ip_address',
  notes: 'Provides geolocation and other details about the specified IP address.'
});

module.exports = ipinfo;
