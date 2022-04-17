'use strict';

const config = require('config');
const { scopedRedisClient } = require('../util');

const nickTrack = async (host, data) => {
  const trimData = Object.assign({}, data);
  delete trimData.__drcNetwork;
  delete trimData.tags;
  trimData.hostname = trimData.hostname.replaceAll(':', '_');
  await scopedRedisClient(async (rc, pfx) => {
    const identStr = [trimData.ident, trimData.hostname].join('@');
    const rKey = [pfx, host, 'nicktrack', identStr].join(':');
    await rc.sadd([rKey, 'uniques'].join(':'), trimData.nick);
    await rc.sadd([rKey, 'uniques'].join(':'), trimData.new_nick);
    await rc.lpush([rKey, 'changes'].join(':'), JSON.stringify({
      timestamp: Number(new Date()),
      ...trimData
    }));
  });
};

module.exports = async function (host, ev, data, context) {
  const {
    logDataToFile
  } = context;

  console.debug('<IRC EVENT>', ev, data);
  if (typeof data !== 'object') {
    console.warn('non-object data!', data);
    return;
  }

  data.__drcNetwork = host;
  const evName = ev.replace(/\s+/g, '_');

  await scopedRedisClient(async (pubClient, PREFIX) =>
    pubClient.publish(PREFIX, JSON.stringify({
      type: 'irc:' + evName,
      data
    })));

  if (config.irc.log.events?.includes(ev)) {
    logDataToFile(evName, data, { pathExtra: ['event'] });
  }

  if (evName === 'nick') {
    nickTrack(host, data);
  }

  if (data?.ident) {
    scopedRedisClient(async (rc, pfx) => await Promise.all(
      [...new Set([data.actual_ip, data.actual_hostname, data.hostname])]
        .map((h) => rc.sadd(`${pfx}:hosttrack:${host}:${data.ident}`, h))));
  }
};
