'use strict';

const os = require('os');
const vm = require('../lib/vm');
const config = require('config');
const { PREFIX, scopedRedisClient } = require('../../util');
const { MessageEmbed } = require('discord.js');
const { servePage, formatKVs } = require('../common');
const { nanoid } = require('nanoid');
const RedisSet = require('../../lib/RedisSet');
const { userScriptsQHWMGauge, userScriptRuntimeHistogram } = require('../promMetrics');

let CallCount = 0;
let QHighWatermark = 0;
let QHighWatermarkClearHandle;
let SCRIPTS_ENABLED = config.app.userScriptsEnabledAtStartup;
let InjectedConstants;
const RKEY = `${PREFIX}:user_scripts`;
const Blocklist = new RedisSet('user_scripts:blocklist');
const BadCompiles = {};
const DRCUserScriptMetrics = {};
const NEW_SCRIPT_PREAMBLE_LINES = [
  'The following globals will be available:',
  '  * DRCUserScript = { channel, constants, data, eventName, state: { get(), set(newState) } }',
  '    ** `state` is unique to each user script and is persisted in redis',
  '  * common = the discord/common.js library',
  '  * util = the util library',
  '  ... and a bunch of other stuff ... ',
  '  (see `mainContext` in discord.js & _run() in discord/userCommands/scripts.js for full details)',
  '',
  'User scripts are run in an async context so top-level await is available.',
  '',
  'This script and all others like it will be run for every IPC message,',
  'so **be quick and be quiet**.'
];

async function _get (scriptName, rawBase64 = false) {
  const raw = await scopedRedisClient(async (r) => r.hget(RKEY, scriptName));
  if (rawBase64) {
    return raw;
  }
  return raw ? Buffer.from(raw, 'base64').toString('utf8') : null;
}

function markScriptFailure (scriptName) {
  if (!BadCompiles[scriptName]) {
    BadCompiles[scriptName] = 0;
  }

  console.error('MARK FAIL', scriptName, BadCompiles[scriptName] + 1);
  return BadCompiles[scriptName]++;
}

const RunQueue = [];
let RunQueueSvcHandle;

async function _run (scriptName, runId, context, runStr) {
  try {
    console.debug(`_run> ${scriptName}`, BadCompiles[scriptName]);
    if (BadCompiles[scriptName] >= 2 && !Blocklist.has(scriptName)) {
      console.error(`Blocklisting ${scriptName}: ${BadCompiles[scriptName]}`, Blocklist);
      // should be a big red MessageEmbed
      context.sendToBotChan(`## Blocklisting \`${scriptName}\` for too many failures (${BadCompiles[scriptName]}).`);
      Blocklist.add(scriptName);
    }

    if (Blocklist.has(scriptName)) {
      return;
    }

    // wrapping the user-script code in a Promise ensures that *we* can catch and
    // handle any async exceptions instead of them bubbling up and crashing the process.
    // it also allows the user-scripts to use top-level await.
    // queueMicrotask() is required in the error handler because otherwise, if many executions
    // are scheduled on the event queue back-to-back, they would otherwise prevent
    // markScriptFailure() from running and causing an infinite-failure-loop as the BadCompiles
    // count would never increment.
    // user-script state is immediately consistent using this execution process *if and only if*
    // user scripts properly await all user-state mutation calls!
    runStr = 'new Promise(async (__drc_inject_resolve, __drc_inject_reject) => {\n' +
    '  try {\n' +
    `    // START DRC USER SCRIPT "${scriptName}"\n\n` +
      runStr + ';\n' +
    `    // END DRC USER SCRIPT "${scriptName}"\n\n` +
    '    __drc_inject_resolve();\n}\n' +
    '  catch (e) { __drc_inject_reject(e); }\n' +
    '\n})\n' +
    '  .catch((err) => {\n' +
    '    queueMicrotask(() => {\n' +
    '      if (DRCUserScript.markScriptFailure() < 2) {\n' +
    '        sendToBotChan(err.message);\n' +
    '        console.error(err);\n' +
    '      }\n' +
    '    });\n' +
    '  });\n';

    const preBadCount = BadCompiles[scriptName];
    await vm.runStringInContext(runStr, context);
    if (preBadCount === BadCompiles[scriptName]) {
      delete BadCompiles[scriptName];
    }
  } catch (e) {
    console.error(scriptName, runId, '_run threw>', e);
    console.error(runStr);
    context.sendToBotChan('Compilation of script "' + scriptName + '" failed:\n\n```\n' + e.message + '\n' + e.stack + '\n```');
    markScriptFailure(scriptName);
  }
}

async function _runQServicer () {
  const next = RunQueue.shift();

  if (next) {
    const { scriptName, runId, context, runStr, resolve, reject } = next;

    try {
      await _run(scriptName, runId, context, runStr);
      resolve();
    } catch (e) {
      console.log('_runQServicer RUN! ', scriptName, runId, RunQueue.length, e);
      reject(e);
    }

    RunQueueSvcHandle = null;
    if (RunQueue.length) {
      if (RunQueue.length > QHighWatermark) {
        console.warn(`New script RunQueue high watermark: ${RunQueue.length} -- ${os.loadavg()}`);
        QHighWatermark = RunQueue.length;
        userScriptsQHWMGauge.set(QHighWatermark);
        clearTimeout(QHighWatermarkClearHandle);
        QHighWatermarkClearHandle = setTimeout(() => {
          userScriptsQHWMGauge.set(0);
          QHighWatermark = 0;
        }, 1 * 60 * 1000);
      }

      RunQueueSvcHandle = setTimeout(_runQServicer, 0);
    }
  }
}

async function run (scriptName, runId, context, ...a) {
  let res, rej;
  const promise = new Promise((resolve, reject) => {
    res = resolve;
    rej = reject;
  });

  RunQueue.push({ scriptName, runId, context, runStr: a.join(' '), resolve: res, reject: rej });

  if (!RunQueueSvcHandle) {
    RunQueueSvcHandle = setTimeout(_runQServicer, 0);
  }

  return promise;
}

async function createEditPage (context, name, readOnly = false) {
  let snippetTextBase64 = await _get(name, true);

  if (!snippetTextBase64) {
    snippetTextBase64 = Buffer.from(
      '// ' + NEW_SCRIPT_PREAMBLE_LINES.join('\n// ') + '\n\n' +
      '// eslint-disable-next-line no-unused-vars\n' +
      '/* globals DRCUserScript, config, common, logger, util, scopedRedisClient, sendToBotChan */\n\n' +
      '// eslint-disable-next-line no-unused-vars\n' +
      'const { channel, constants, data, eventName, state } = DRCUserScript;\n\n'
      , 'utf8').toString('base64');
  }

  return servePage(context, {
    snippetTextBase64,
    name,
    keyComponent: 'user_scripts',
    editorDefaultTheme: config.http.editor.defaultTheme,
    editorDefaultFontSize: config.http.editor.defaultFontSizePt,
    readOnly
  }, 'editor', null, !readOnly);
}

async function listSnippets (context, ...a) {
  return scopedRedisClient(async (r) => {
    return '\n## User Scripts:\n' +
    (await Promise.all((await r.hkeys(RKEY)).flatMap(async (k) => [
      k,
      await _get(k),
      (context.options.full ? await createEditPage(context, k) : null),
      DRCUserScriptMetrics[k]?.averageMs,
      Blocklist.has(k) ? '~~' : '**'
    ])))
      .sort(([nameA], [nameB]) => nameB.localeCompare(nameA))
      .reduce((a, [name, data, editId, averageMs, nameWrap]) =>
        `\n* ${nameWrap}${name}${nameWrap} ` + ' -- ' + data.length + ' bytes' +
        (Blocklist.has(name) || !SCRIPTS_ENABLED ? '' : `, ${Number(averageMs).toFixed(1)}ms avg runtime`) +
        (editId ? `\n   * https://${config.http.fqdn}/${editId}` : '') +
        a, ''
      ) + '\n\n' +
      formatKVs({
        'Enabled globally': SCRIPTS_ENABLED,
        'Enabled at startup': config.app.userScriptsEnabledAtStartup,
        'Call count': CallCount,
        'Queue high watermark': QHighWatermark,
        'Avg runtime (ms)': Number(Object.entries(
          DRCUserScriptMetrics)
          .map(([, { averageMs }]) => averageMs)
          .reduce((a, x) => a + x, 0) /
            Object.keys(DRCUserScriptMetrics).length).toFixed(2)
      });
  });
}

async function delSnippet (context, ...a) {
  const name = a.shift();
  delete DRCUserScriptMetrics[name];
  return Promise.all([
    scopedRedisClient((r) => r.hdel(RKEY + ':state', name)),
    scopedRedisClient((r) => r.hdel(RKEY, name))
  ]);
}

async function edit (context, ...a) {
  const [name] = a;
  const isNew = !(await _get(name, true));
  const pageName = await createEditPage(context, name, context.options?.readOnly);
  const embed = new MessageEmbed()
    .setColor(config.app.stats.embedColors.main)
    .setTitle(`Click to ${isNew ? 'create' : 'edit'} ${name}`)
    .setDescription('This page captures the script at the moment the page was created.\n' +
    'Reloading or refreshing it will accordingly bring back the original script content.' +
    (isNew
      ? '\n\nAs this is a new script, it will automatically be disabled. `' +
      `${config.app.allowedSpeakersCommandPrefixCharacter}scripts enableScript ${name}` +
      '` to start it running.'
      : ''))
    .setURL(`https://${config.http.fqdn}/${pageName}`);

  // automatically disable new scripts, requiring explicit user intervention to start them
  if (isNew) {
    Blocklist.add(name);
  }

  await context.sendToBotChan({ embeds: [embed] }, true);
}

async function rename (context, ...a) {
  const [src, dest] = a;

  if (!src || !dest) {
    return 'Bad src or dest';
  }

  const orig = await _get(src, true);
  if (!orig) {
    return 'Bad orig';
  }

  await scopedRedisClient((r) => r.hset(RKEY, dest, orig));
  return scopedRedisClient((r) => r.hdel(RKEY, src));
}

async function constants (context, ...a) {
  let [name, val] = a;

  if (context.options?.deleteAll) {
    return scopedRedisClient((r) => r.set(RKEY + '__CONSTANTS', JSON.stringify({})));
  }

  if (!InjectedConstants) {
    InjectedConstants = await scopedRedisClient(async (r) => JSON.parse(await r.get(RKEY + '__CONSTANTS'))) ?? {};
  }

  if (!name) {
    return '\n## Available injected constants:\n' + formatKVs(InjectedConstants);
  }

  if (!val) {
    return InjectedConstants[name];
  }

  const valFParsed = Number.parseFloat(val);
  if (!Number.isNaN(valFParsed)) {
    val = valFParsed;
  } else {
    try {
      val = JSON.parse(val);
    } catch {}
  }

  InjectedConstants[name] = val;
  await scopedRedisClient((r) => r.set(RKEY + '__CONSTANTS', JSON.stringify(InjectedConstants)));
  return val;
}

function metrics () {
  const sourceDataByScriptName = Object.fromEntries(Object.entries({ ...DRCUserScriptMetrics }).map(([scriptName, scriptMetrics]) => ([
    scriptName,
    Object.fromEntries(Object.entries(scriptMetrics).filter(([k]) => !['window'].includes(k)))
  ])));

  return {
    sourceDataByScriptName,
    totalCallCount: CallCount,
    sortedByHeaviest: Object.entries(sourceDataByScriptName)
      .sort(([, metricsA], [, metricsB]) => metricsB.averageMs - metricsA.averageMs)
      .map(([name]) => name)
  };
}

const helpText = {
  del: 'Delete the script named "name" (first arugment)',
  get: 'Get the script contents for "name" (first arugment)',
  edit: 'Edit a user script with "name" (first argument). If "name" doesn\'t exist, a new user script will be created.',
  disable: 'Globally disable all user scripts from running',
  enable: 'Globally allow user scripts to run',
  rename: 'Rename "src" (first arg) to "dest" (second arg)',
  constants: 'Get (one arg) or set (two args) injected constants',
  metrics: 'Get user script run time metrics',
  disableScript: 'Disable script',
  ensableScript: 'Enable script'
};

const subCommands = {
  del: delSnippet,
  edit,
  get: async function (context, ...a) {
    const name = a.shift();
    return 'User Script "`' + name + '`":\n```javascript\n' + (await _get(name)) + '\n```';
  },
  disable: () => (SCRIPTS_ENABLED = false),
  enable: () => (SCRIPTS_ENABLED = true),
  areEnabled: (context) => context.sendToBotChan(`Scripts are currently **${SCRIPTS_ENABLED ? 'en' : 'dis'}abled**.`),
  rename,
  constants,
  metrics,
  disableScript: (context, ...a) => Blocklist.add(a.shift()),
  enableScript: (context, ...a) => {
    const [scriptName] = a;
    delete BadCompiles[scriptName];
    Blocklist.delete(scriptName);
  }
};

async function f (context, ...a) {
  const subCmd = a.shift();

  if (subCommands[subCmd]) {
    return subCommands[subCmd](context, ...a);
  }

  return listSnippets(context, ...a);
}

f.__drcHelp = () => ({
  title: 'User Scripts',
  notes: 'Scripts are run for **every IPC message** so be sure that they run quickly and quietly.',
  usage: 'subcommand [...]',
  subcommands: Object.keys(subCommands).reduce((a, x) => ({ [x]: { text: helpText[x] }, ...a }), {})
});

f.runScriptsForEvent = async function (context, eventName, data, channel) {
  if (!SCRIPTS_ENABLED) {
    return;
  }

  const allScripts = Object.entries(await scopedRedisClient((r) => r.hgetall(RKEY)));
  if (!allScripts.length) {
    return;
  }

  for (const [scriptName, scriptBase64] of allScripts) {
    if (Blocklist.has(scriptName)) {
      continue;
    }

    const script = Buffer.from(scriptBase64, 'base64').toString('utf8');
    const sendToBotChan = async (...a) => {
      if (a.length > 3 || a.length < 1) {
        throw new Error('Nope! Bad user script');
      }
      if (a.length === 1) {
        a.push(false); // `raw`
      }
      a.push(true); // `fromUserScript`

      context.sendToBotChan(...a);
      context.sendToBotChan(`### source: \`${scriptName}\``, false, true);
    };

    if (!InjectedConstants) {
      await constants(context);
    }

    const _start = process.hrtime.bigint();
    const runId = nanoid();
    try {
      await run(scriptName, runId, {
        ...context,
        sendToBotChan,
        DRCUserScript: Object.freeze({
          runId,
          markScriptFailure: markScriptFailure.bind(null, scriptName),
          constants: InjectedConstants,
          eventName,
          data,
          channel,
          state: {
            async get () {
              try {
                return JSON.parse(await scopedRedisClient((client) =>
                  client.hget(RKEY + ':state', scriptName))) ?? null;
              } catch {
                console.error('Bad user script state json', RKEY + ':state', scriptName);
              }

              return null;
            },

            async set (newVal) {
              return scopedRedisClient((client) =>
                client.hset(RKEY + ':state', scriptName, JSON.stringify(newVal)));
            }
          }
        })
      },
      script);
    } catch (e) {
      console.error('caught in runScriptsForEvent', scriptName, eventName);
      markScriptFailure(scriptName);
    }

    const metrics = DRCUserScriptMetrics[scriptName] ?? {
      window: []
    };

    const _runtimeMs = Number(process.hrtime.bigint() - _start) / 1e6;
    metrics.window.push(_runtimeMs);
    if (metrics.window.length === 25) {
      metrics.window.shift();
    }

    DRCUserScriptMetrics[scriptName] = {
      ...metrics,
      averageMs: metrics.window.reduce((a, x) => a + x) / metrics.window.length
    };

    userScriptRuntimeHistogram.observe({ scriptName }, _runtimeMs);
  }

  CallCount++;
};

f.__init = async () => Blocklist.init();

// for when ;reload is called
f.__init();

module.exports = f;
