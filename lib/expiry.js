'use strict';

const config = require('config');

function expiryDurationFromOptions (options) {
  if (options?.ttl === -1) {
    return null;
  }
  return (options.ttl ? options.ttl * 60 : config.http.ttlSecs) * 1000;
}

function expiryFromOptions (options) {
  if (options?.ttl === -1) {
    return null;
  }
  return Number(new Date()) + expiryDurationFromOptions(options);
}

module.exports = {
  expiryFromOptions,
  expiryDurationFromOptions
};
