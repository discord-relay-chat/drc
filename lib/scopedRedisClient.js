'use strict';

const fs = require('fs');
const config = require('config');
const Redis = require(process.env.NODE_ENV === 'test' ? 'ioredis-mock' : 'ioredis');

const PKGJSON = JSON.parse(fs.readFileSync('package.json'));
const NAME = PKGJSON.name;
const ENV = process.env.NODE_ENV || 'dev';
const PREFIX = config.redis.prefixOverride || [NAME, ENV].join('-');

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
