function lastParamsElementOrPassthru (s) {
  if (s.params) {
    return s.params.slice(-1).join(' ');
  }

  return s;
}

function concatLastTwoParamsElementOrPassthru (s) {
  if (s.params && s.params.length > 2) {
    return s.params.slice(-2).join(' ');
  }

  return s;
}

function allButFirstParams (s) {
  return s.params.slice(1).join(' ');
}

module.exports = {
  1: {
    name: 'RPL_WELCOME',
    parse: (s) => s
  },
  3: {
    name: 'RPL_CREATED',
    parse: lastParamsElementOrPassthru
  },
  4: {
    name: 'RPL_MYINFO',
    parse: (s) => s.params ? s.params.slice(1, 3).join(' ') : s
  },
  250: {
    name: 'RPL_STATSCONN',
    parse: lastParamsElementOrPassthru
  },
  251: {
    name: 'RPL_LUSEROP',
    parse: allButFirstParams
  },
  252: {
    name: 'RPL_LUSERCLIENT',
    parse: allButFirstParams
  },
  253: {
    name: 'RPL_LUSERUNKNOWN',
    parse: concatLastTwoParamsElementOrPassthru
  },
  254: {
    name: 'RPL_LUSERCHANNELS',
    parse: concatLastTwoParamsElementOrPassthru
  },
  255: {
    name: 'RPL_LUSERME',
    parse: lastParamsElementOrPassthru
  },
  265: {
    name: 'RPL_LOCALUSERS',
    parse: lastParamsElementOrPassthru
  },
  266: {
    name: 'RPL_GLOBALUSERS',
    parse: lastParamsElementOrPassthru
  },
  728: {
    name: 'QUIET_LIST_ENTRY',
    parse: (s) => {
      const {
        params: [,,, quieted, quietedBy, quietTime],
        tags: { time }
      } = s;

      return `\`${quieted}\` was quieted by \`${quietedBy}\` at ` +
        `**${time ?? new Date(quietTime).toDRCString()}**`;
    }
  },
  729: {
    name: 'QUIET_LIST_END',
    parse: (s) => {
      const { params: [, channel] } = s;
      return `End of quiet list for **${channel}**.`;
    }
  }
};
