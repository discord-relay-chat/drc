'use strict';

const config = require('config');
const { formatKVsWithOpts } = require('../common');
const { matchNetwork, scopedRedisClient } = require('../../util');

async function f (context, ...a) {
  const [netStub] = a;
  const { network } = matchNetwork(netStub);

  await scopedRedisClient(async (rc, prefix) => {
    for (const pf of ['kickee', 'kicker', 'chans', 'reasons']) {
      const k = `${prefix}:kicks:${network}:${pf}`;
      const vals = await rc.zrevrangebyscore(k, 'inf', 0, 'limit', 0, config.app.maxNumKicks);
      const vs = {};

      for (const v of vals) {
        vs[v] = await rc.zscore(k, v);
      }

      await context.sendToBotChan(`**${pf}**:\n\n` + formatKVsWithOpts(vs, { sortByValue: -1 }));
    }
  });
}

module.exports = f;
