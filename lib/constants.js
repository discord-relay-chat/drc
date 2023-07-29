'use strict';

const fs = require('fs');
const config = require('config');

const PKGJSON = JSON.parse(fs.readFileSync('package.json'));
const NAME = PKGJSON.name;
const ENV = process.env.NODE_ENV || 'dev';
const PREFIX = config.redis.prefixOverride || [NAME, ENV].join('-');

module.exports = Object.freeze({
  PKGJSON,
  NAME,
  ENV,
  PREFIX
});
