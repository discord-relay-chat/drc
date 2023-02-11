'use strict';

const fs = require('fs');
const config = require('config');
const Redis = require(process.env.NODE_ENV === 'test' ? 'ioredis-mock' : 'ioredis');
const { nanoid } = require('nanoid');
const scopedRedisClient = require('./scopedRedisClient');

const PKGJSON = JSON.parse(fs.readFileSync('package.json'));
const NAME = PKGJSON.name;
const ENV = process.env.NODE_ENV || 'dev';
const PREFIX = config.redis.prefixOverride || [NAME, ENV].join('-');

async function isXRunning (xName, context, timeoutMs = 1500) {
  const { registerOneTimeHandler, removeOneTimeHandler } = context;
  const reqId = nanoid();
  const keyPrefix = `is${xName}Running`;
  const retProm = new Promise((resolve) => {
    const timeoutHandle = setTimeout(() => resolve(null), timeoutMs);
    const respName = `isXRunning:${keyPrefix}Response`;
    registerOneTimeHandler(respName, reqId, async (data) => {
      clearTimeout(timeoutHandle);
      removeOneTimeHandler(respName, reqId);
      resolve(data);
    });
  });

  await scopedRedisClient(async (client, prefix) => client.publish(prefix, JSON.stringify({
    type: `isXRunning:${keyPrefix}Request`,
    data: { reqId }
  })));

  return retProm;
}

async function isXRunningRequestListener (xName, messageCallback) {
  const client = new Redis(config.redis.url);
  const reqKey = `isXRunning:is${xName}RunningRequest`;

  await client.subscribe(PREFIX, (err) => {
    if (err) {
      throw err;
    }

    client.on('message', async (_chan, msg) => {
      try {
        const { type, data } = JSON.parse(msg);
        if (type === reqKey) {
          await messageCallback(data);
        }
      } catch (e) {
        console.warn(`isXRunningRequestListener(${xName}) malformed message:`, e, msg);
      }
    });
  });

  return client;
}

async function isHTTPRunning (regOTHandler, rmOTHandler, timeoutMs = 500) {
  return isXRunning('HTTP', { registerOneTimeHandler: regOTHandler, removeOneTimeHandler: rmOTHandler }, timeoutMs);
}

module.exports = {
  isXRunning,
  isXRunningRequestListener,
  isHTTPRunning
};
