'use strict';

const config = require('config');
const Redis = require(process.env.NODE_ENV === 'test' ? 'ioredis-mock' : 'ioredis');
const { PREFIX } = require('./constants');

module.exports = async function scopedRedisClient (scopeCb) {
  const scopeClient = new Redis(config.redis.url);

  try {
    return await scopeCb(scopeClient, PREFIX);
  } catch (e) {
    console.error(e);
  } finally {
    scopeClient.disconnect();
  }

  return null;
};
