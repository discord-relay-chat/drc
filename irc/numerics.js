function lastParamsElementOrPassthru (s) {
  if (s.params) {
    return s.params.slice(-1);
  }

  return s;
}

function concatLastTwoParamsElementOrPassthru (s) {
  if (s.params && s.params.length > 2) {
    return s.params.slice(-2).join(' ');
  }

  return s;
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
    parse: (s) => s.params ? s.params.slice(1, 3) : s
  },
  250: {
    name: 'RPL_STATSCONN',
    parse: lastParamsElementOrPassthru
  },
  251: {
    name: 'RPL_LUSEROP',
    parse: (s) => {
      console.log(`WTF IS RPL_LUSEROP? ${JSON.stringify(s)}`, s);
      return s;
    }
  },
  252: {
    name: 'RPL_LUSERCLIENT',
    parse: lastParamsElementOrPassthru
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
  }
};
