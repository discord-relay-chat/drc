'use strict';

const { fmtDuration } = require('../../util');

module.exports = async function (parsed, context) {
  if (!parsed.stats) {
    throw new Error('expecting stats but none!');
  }

  parsed.stats.uptime = fmtDuration(new Date(parsed.stats.upSince));
  await context.runOneTimeHandlersMatchingDiscriminator(parsed.type, parsed.stats, 'stats');
};
