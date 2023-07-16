'use strict';

const vm = require('vm');
const config = require('config');
const { fetch } = require('undici');
const logger = require('../../logger')('discord');
const { PREFIX, scopedRedisClient } = require('../../util');

const AllowedGlobals = ['Object', 'Function', 'Array', 'Number', 'parseFloat', 'parseInt', 'Infinity', 'NaN', 'undefined',
  'Boolean', 'String', 'Symbol', 'Date', 'Promise', 'RegExp', 'Error', 'AggregateError', 'EvalError', 'RangeError',
  'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'globalThis', 'JSON', 'Math', 'Intl', 'ArrayBuffer',
  'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array',
  'Uint8ClampedArray', 'BigUint64Array', 'BigInt64Array', 'DataView', 'Map', 'BigInt', 'Set', 'WeakMap', 'WeakSet',
  'Proxy', 'Reflect', 'FinalizationRegistry', 'WeakRef', 'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent',
  'escape', 'unescape', 'isFinite', 'isNaN', 'Buffer', 'atob', 'btoa', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'clearInterval', 'clearTimeout', 'setInterval', 'setTimeout', 'queueMicrotask', 'performance', 'clearImmediate', 'setImmediate',
  'SharedArrayBuffer', 'Atomics', 'buffer', 'constants', 'crypto', 'dgram', 'dns', 'domain', 'fs', 'http', 'http2', 'https',
  'net', 'os', 'path', 'querystring', 'readline', 'stream', 'string_decoder', 'timers', 'tls', 'url', 'zlib', 'util']
  .reduce((a, x) => ({ [x]: global[x], ...a }), {});

async function runStringInContext (runStr, context) {
  let wasAwaited = false;
  let result = vm.runInNewContext(runStr, {
    ...context,
    ...AllowedGlobals,
    logger,
    config,
    PREFIX,
    common: require('../common'),
    util: require('../../util'),
    fetch,
    scopedRedisClient,
    src: scopedRedisClient,
    stbc: context.sendToBotChan,
    sendToBotChan: context.sendToBotChan,
    console
  });

  if (result instanceof Promise) {
    result = await result;
    wasAwaited = true;
  }

  return {
    result,
    wasAwaited
  };
}

module.exports = { runStringInContext };
