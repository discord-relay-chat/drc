'use strict';

const { matchNetwork, scopedRedisClient } = require('../../util');

async function f (context, ...a) {
  const [netStub] = a;
  const { network } = matchNetwork(netStub);

  return scopedRedisClient(async (rc, prefix) => {
    const m = {};

    for (const pf of ['kickee', 'kicker', 'chans', 'reasons']) {
      const k = `${prefix}:kicks:${network}:${pf}`;
      const vals = await rc.zrangebyscore(k, 0, 'inf');
      const vs = [];

      for (const v of vals) {
        vs.push({ [v]: await rc.zscore(k, v) });
      }

      m[pf] = vs;
    }

    return m;
  });
}

module.exports = f;
