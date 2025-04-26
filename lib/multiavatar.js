'use strict';

const crypto = require('crypto');
const { scopedRedisClient } = require('../util');

const REDIS_KEY = (p) => `${p}:multiavatar:apiKey`;

async function generateApiKey () {
  return crypto.randomBytes(16).toString('hex');
}

async function getApiKey () {
  const key = await scopedRedisClient((c, p) => c.get(REDIS_KEY(p)));
  if (!key) {
    return rotateApiKey();
  }
  return key;
}

async function setApiKey (key) {
  return scopedRedisClient((c, p) => c.set(REDIS_KEY(p), key));
}

async function rotateApiKey () {
  const newKey = await generateApiKey();
  await setApiKey(newKey);
  return newKey;
}

module.exports = {
  getApiKey,
  setApiKey,
  rotateApiKey,
  generateApiKey
};
