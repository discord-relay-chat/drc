'use strict';

const vm = require('vm');
const config = require('config');
const logger = require('../../logger')('discord');
const { PREFIX, scopedRedisClient } = require('../../util');

const RKEY = `${PREFIX}:jssaved`;

async function _run (context, runStr) {
  try {
    console.log(`runStr> ${runStr}`);
    const res = vm.runInNewContext(runStr, {
      logger,
      config,
      PREFIX,
      common: require('../common'),
      util: require('../../util'),
      src: scopedRedisClient,
      stbc: context.sendToBotChan,
      setTimeout,
      ...context
    });

    console.log(`res>    ${res}`);
    context.sendToBotChan('```\n' + res + '\n```\n');
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
