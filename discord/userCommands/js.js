'use strict';

const vm = require('vm');
const config = require('config');
const logger = require('../../logger')('discord');
const { PREFIX, scopedRedisClient } = require('../../util');

const RKEY = `${PREFIX}:jssaved`;

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

async function _run (context, runStr) {
  try {
    console.log(`runStr> ${runStr}`);
    let res = vm.runInNewContext(runStr, {
      ...context,
      ...AllowedGlobals,
      logger,
      config,
      PREFIX,
      common: require('../common'),
      util: require('../../util'),
      src: scopedRedisClient,
      stbc: context.sendToBotChan,
      console: {
        debug: context.sendToBotChan,
        log: context.sendToBotChan,
        warn: context.sendToBotChan,
        error: context.sendToBotChan
      }
    });

    let wasAwaited = false;
    if (res instanceof Promise) {
      res = await res;
      wasAwaited = true;
    }

    console.log(`res ${wasAwaited ? '(awaited)' : ''}>    ${res}`);
    context.sendToBotChan('```\n' + JSON.stringify(res, null, 2) + '\n```\n');
  } catch (e) {
    console.error('runInNewContext threw>', e);
    context.sendToBotChan('Compilation failed:\n\n```\n' + e.message + '\n' + e.stack + '\n```');
  }
}

async function run (context, ...a) {
  return _run(context, a.join(' '));
}

async function saveSnippet (context, ...a) {
  const name = a.shift();
  return scopedRedisClient((r) => r.hset(RKEY, name, a.join(' ')));
}

async function listSnippets (context, ...a) {
  return scopedRedisClient(async (r) => {
    return '\nSaved snippets:\n' + (await Promise.all((await r.hkeys(RKEY)).flatMap(async (k) => [k, await r.hget(RKEY, k)])))
      .reduce((a, ar) => `\n"**${ar[0]}**"\n` + '```javascript\n' + ar[1] + '\n```' + a, '');
  });
}

async function runSnippet (context, ...a) {
  const name = a.shift();
  const snippet = await scopedRedisClient((r) => r.hget(RKEY, name));

  if (snippet) {
    console.warn('runSnippet:', name, '<WANT TO RUN>', snippet);
    return run(context, snippet);
  }

  return null;
}

async function delSnippet (context, ...a) {
  const name = a.shift();
  return scopedRedisClient((r) => r.hdel(RKEY, name));
}

const subCommands = {
  exec: run,
  save: saveSnippet,
  list: listSnippets,
  run: runSnippet,
  del: delSnippet,
  get: async function (context, ...a) {
    const name = a.shift();
    return '```javascript\n' + await scopedRedisClient((r) => r.hget(RKEY, name)) + '\n```';
  }
};

async function f (context, ...a) {
  const subCmd = a.shift();

  if (subCommands[subCmd]) {
    return subCommands[subCmd](context, ...a);
  }

  return null;
}

const helpText = {
  exec: 'Immediately execute the following code',
  save: 'Save a snippet with "name" (first argument)',
  list: 'List all saved snippets',
  run: 'Run a snippet saved with "name" (first arugment)',
  del: 'Delete the snippet named "name" (first arugment)',
  get: 'Get a saved snippet named "name" (first arugment)\'s source without executing it'
};

f.__drcHelp = () => ({
  title: 'Javascript VM',
  usage: 'subcommand [javascript]',
  subcommands: Object.keys(subCommands).reduce((a, x) => ({ [x]: { text: helpText[x] }, ...a }), {})
});

module.exports = f;
