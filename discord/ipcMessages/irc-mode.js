'use strict';

const config = require('config');

module.exports = async function (parsed, context) {
  const { sendToBotChan } = context;
  console.debug('MODE RAW!', parsed);
  if (parsed.data.raw_modes !== '+l') {
    const ourNick = config.irc.registered[parsed.data.__drcNetwork]?.user.nick;

    if (config.user.showAllModeChanges || (ourNick && parsed.data.raw_params.some(x => x.includes(ourNick)))) {
      sendToBotChan(`**${parsed.data.nick}** set \`${parsed.data.raw_modes}\` on ` +
        `\`${parsed.data.__drcNetwork}\`/**${parsed.data.target}**` +
        `${parsed.data.raw_params.length ? ` for **${parsed.data.raw_params.join('**, **')}**` : ''}`);
    }
  }
};
