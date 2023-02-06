'use strict';

const { nanoid } = require('nanoid');
const { scopedRedisClient } = require('../util');

const QUERY_DEFAULTS = {
  limit: 5,
  latestFirst: true,
  sortAscending: false
};

module.exports = {
  async push (command, metadata = {}) {
    return scopedRedisClient(async (client, prefix) => {
      const setScoreTs = Number(new Date());
      const entryId = nanoid();
      const hashKey = `${entryId}.${setScoreTs}`;
      const writeObj = { command, metadata, setScoreTs, entryId, hashKey };
      await client.hset(`${prefix}:userCommandHistory:data`, hashKey, JSON.stringify(writeObj));
      await client.zadd(`${prefix}:userCommandHistory:series`, setScoreTs, hashKey);
      return writeObj;
    });
  },

  QUERY_DEFAULTS,

  async query ({
    limit = QUERY_DEFAULTS.limit,
    latestFirst = QUERY_DEFAULTS.latestFirst,
    sortAscending = QUERY_DEFAULTS.sortAscending,
    from,
    to
  } = {}) {
    const dirMethod = latestFirst ? 'zrevrange' : 'zrange';
    return scopedRedisClient(async (client, prefix) => {
      const retList = (await Promise.all((await client[dirMethod](`${prefix}:userCommandHistory:series`, 0, limit - 1))
        .map((hashKey) => client.hget(`${prefix}:userCommandHistory:data`, hashKey))))
        .map(JSON.parse);

      return !sortAscending ? retList.reverse() : retList;
    });
  },

  async topX (modifier = 'commandSuccess', {
    limit = QUERY_DEFAULTS.limit,
    sortAscending = QUERY_DEFAULTS.sortAscending
  } = {}) {
    const selector = sortAscending ? 'zrange' : 'zrevrange';
    return scopedRedisClient(async (client, prefix) =>
      client[selector]([prefix, 'userCommandCalls', modifier].join(':'), 0, limit, 'WITHSCORES'));
  }
};
