const { spawn } = require('../../spawn');

const WhitelistedArgs = {
  df: ['-h'],
  uptime: [],
  who: ['-ub']
};

module.exports = function (context, ...a) {
  const [binary] = context.options._;
  if (!binary || !WhitelistedArgs[binary]) {
    return `Bad argument (${binary})`;
  }

  return new Promise((resolve, reject) => {
    const df = spawn(binary, WhitelistedArgs[binary]);
    let out = '';
    df.stdout.on('data', (data) => (out += data));
    df.on('close', () => resolve('Output of `' +
      [binary, ...WhitelistedArgs[binary]].join(' ') +
      '`:\n```\n' + out + '\n```\n'));
    df.on('error', (err) => reject(err));
  });
};
