'use strict';

const dfns = require('date-fns');
const parseDuration = require('parse-duration');
const { parseDate } = require('chrono-node');

module.exports = {
  fmtDuration (start, allowSeconds, end = new Date()) {
    if (typeof start === 'string') {
      start = dfns.parseISO(start);
    }

    const defOpts = ['years', 'months', 'weeks', 'days', 'hours', 'minutes'];

    if (allowSeconds) {
      defOpts.push('seconds');
    }

    const options = { format: defOpts };
    const fmt = () => dfns.formatDuration(dfns.intervalToDuration({ start, end }), options);
    let dur = fmt();

    if (!dur) {
      options.format.push('seconds');
      dur = fmt();
    }

    if (dur.match(/days/)) {
      options.format.pop();
      dur = fmt();
    }

    return dur;
  },

  tryToParseADateOrDuration (maybeADuration) {
    const chkDate = new Date(maybeADuration);

    if (chkDate.toString() === 'Invalid Date') {
      let parsed = parseDate(maybeADuration);

      if (parsed) {
        return Number(parsed);
      }

      parsed = parseDuration(maybeADuration);

      if (parsed) {
        return Number(new Date()) + parsed;
      }

      return undefined;
    }

    return chkDate;
  }
};
