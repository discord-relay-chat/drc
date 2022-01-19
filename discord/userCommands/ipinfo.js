'use strict';

const { ipInfo } = require('../../util');
const { formatKVs } = require('../common');

module.exports = async function (context) {
  if (!context.argObj._[0]) {
    return null;
  }

  return `\nIP info for **${context.argObj._[0]}**:\n` + formatKVs(await ipInfo(context.argObj._[0]));
};
