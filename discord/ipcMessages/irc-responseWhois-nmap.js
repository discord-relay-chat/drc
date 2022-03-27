'use strict';

const config = require('config');
const { fmtDuration } = require('../../util');

module.exports = async function (parsed, context) {
  const { sendToBotChan } = context;
  const wd = parsed.data.whoisData;

  const maxLen = Math.floor(config.discord.maxMsgLength * 0.9);
  for (let idx = 0; idx < parsed.data.stdout.length; idx += maxLen) {
    const str = '`IRC:WHOIS:NMAP` `STDOUT` ' +
      `(_page ${Math.floor(idx / maxLen) + 1}_) for **${wd.nick}** <_${wd.ident}@${wd.hostname}_>:` +
      '\n```\n' + parsed.data.stdout.slice(idx, idx + maxLen) + '\n```\n';

    console.debug(str);
    sendToBotChan(str);
  }

  if (parsed.data.stderr.length) {
    for (let idx = 0; idx < parsed.data.stderr.length; idx += maxLen) {
      const str = '`IRC:WHOIS:NMAP` `STDERR` ' +
        `(_page ${Math.floor(idx / maxLen) + 1}_) for **${wd.nick}** <_${wd.ident}@${wd.hostname}_>:` +
        '\n```\n' + parsed.data.stderr.slice(idx, idx + maxLen) + '\n```\n';

      console.debug(str);
      sendToBotChan(str);
    }
  }

  if (parsed.data.started) {
    sendToBotChan('`IRC:WHOIS:NMAP` ran for ' + fmtDuration(new Date(parsed.data.started)));
  }
};
