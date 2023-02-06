const _ = require('lodash');
const config = require('config');
const { PREFIX } = require('../../util');
const { formatKVs } = require('../common');

async function userCommandConfig (context, ...a) {
  const key = PREFIX + ':userConfig';

  switch (a[0]) {
    case 'get':
      return '\n\n' + formatKVs(_.get(
        config._replace(Object.assign({}, config), config._secretKeys, '*<REDACTED>*'), a[1]));

    case 'set':
    {
      let setValue = a.slice(2).join(' ').toLocaleLowerCase();
      const onWords = ['on', '1', 'true', 'yes'];
      const offWords = ['off', '0', 'false', 'no'];

      if (onWords.includes(setValue)) {
        setValue = true;
      } else if (offWords.includes(setValue)) {
        setValue = false;
      }

      _.set(config, a[1], setValue);
      const ppathArr = a[1].split('.');
      ppathArr.pop();

      if (a[1].indexOf('user') === 0) {
        await context.redis.set(key, JSON.stringify(config.user));
      }

      return '\n' + formatKVs(_.get(config, ppathArr.length ? ppathArr.join('.') : a[1]));
    }

    case 'load':
    {
      try {
        const uStr = await context.redis.get(key);

        if (!uStr) {
          return config.user;
        }

        const uCfg = JSON.parse(uStr);

        if (Object.keys(uCfg).length !== Object.keys(config.user).length ||
          Object.keys(config.user).reduce((a, k) => (a += Object.keys(uCfg).includes(k) ? 1 : 0), 0) !== Object.keys(config.user).length) {
          throw new Error('bad config reload, keys mistmatch!!', uCfg, config.user);
        }

        return (config.user = uCfg);
      } catch (e) {
        // if load fails, remove whatever's in redis, it's bad
        await context.redis.del(key);

        return {
          error: {
            message: `Failed to retrieve user config: ${e.message}`,
            stack: e.stack
          }
        };
      }
    }
  }
}

module.exports = userCommandConfig;
