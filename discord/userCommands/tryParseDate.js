'use strict';

const { tryToParseADateOrDuration } = require('../../util');
const { formatKVs } = require('../common');

module.exports = async function (context) {
  try {
    console.log(context.options, context.options._[0]);
    let tryDate = tryToParseADateOrDuration(context.options._[0]);

    if (!(tryDate instanceof Date)) {
      tryDate = new Date(tryDate);
    }

    console.log('tryDate', tryDate);
    return formatKVs(Object.getOwnPropertyNames(Date.prototype)
      .filter((s) => s.indexOf('to') === 0)
      .reduce((a, toFuncName) => ({ ...a, [toFuncName]: tryDate[toFuncName]() }), {}));
  } catch (e) {
    return `Nope! ${e}`;
  }
};
