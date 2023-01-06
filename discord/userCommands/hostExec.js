const config = require('../../config');
const { spawn } = require('../../spawn');

const WhitelistedArgs = {
  df: ['-h'],
  uptime: [],
  who: ['-ub'],
  nmap: config.nmap.defaultOptions
};

module.exports = function (context, ...a) {
  let [binary] = context.options._;
  if (!binary || !WhitelistedArgs[binary]) {
    return `Bad argument (${binary})`;
  }

  let args = WhitelistedArgs[binary];
  if (binary === 'nmap') {
    const [, targetIp] = context.options._;
    args = [binary, ...args, targetIp];
    binary = 'sudo';
  }

  return new Promise((resolve, reject) => {
    const df = spawn(binary, args);
    let out = '';
    df.stdout.on('data', (data) => (out += data));
    df.on('close', () => resolve('Output of `' +
      [binary, ...args].join(' ') +
      '`:\n```\n' + out + '\n```\n'));
    df.on('error', (err) => reject(err));
  });
};
