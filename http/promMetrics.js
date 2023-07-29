'use strict';

const { Counter } = require('../lib/promRedisExport')('http');

const requestCounter = new Counter({
  name: 'drc_http_request',
  help: 'An HTTP request',
  labelNames: ['method', 'path']
});

const notFoundCounter = new Counter({
  name: 'drc_http_not_found',
  help: 'An HTTP 404 request',
  labelNames: ['method', 'path']
});

const responseCounter = new Counter({
  name: 'drc_http_response',
  help: 'An HTTP response (non-404)',
  labelNames: ['method', 'path', 'code']
});

module.exports = {
  requestCounter,
  notFoundCounter,
  responseCounter
};
