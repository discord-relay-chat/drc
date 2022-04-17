'use strict';

const path = require('path');
const uuid = require('uuid');
const { nanoid } = require('nanoid');
const { PREFIX, AmbiguousMatchResultError, matchNetwork, scopedRedisClient } = require('../util');
const { dynRequireFrom, generateListManagementUCExport } = require('./common');

const MODULENAME = path.join(__dirname, path.parse(__filename).name);

const fileExportReqdPaths = [];
const fileExportsPath = path.join(__dirname, path.parse(__filename).name);
const fileExports = dynRequireFrom(fileExportsPath, (fPath) => fileExportReqdPaths.push(fPath));

function resolver (functionName) {
  const fs = require(MODULENAME).__functions;
  let f = fs[functionName];

  if (!f) {
    const matches = Object.keys(fs).sort().filter(x => x.match(new RegExp(`^${functionName}`)));

    if (matches.length > 1) {
      throw new AmbiguousMatchResultError('Possibile matches: ' + matches.join(', '));
    }

    f = fs[matches[0]];
  }

  return f;
}

resolver.__unrequireCommands = function () {
  [
    '../util',
    './common',
    ...fileExportReqdPaths
  ]
    .forEach((fPath) => {
      delete require.cache[require.resolve(fPath)];
      require(require.resolve(fPath));
    });
};

resolver.__unresolve = function () {
  require(MODULENAME).__unrequireCommands();
  delete require.cache[require.resolve(MODULENAME)];
  require(MODULENAME);
};

resolver.__functions = {
  ...fileExports,

  async ps (context) {
    await context.redis.publish(PREFIX, JSON.stringify({ type: 'discord:requestPs:irc' }));
  },

  hilite: generateListManagementUCExport('hilite'),

  onConnect: generateListManagementUCExport('onConnect'),

  diediedie: () => {
    console.warn('Got DIE DIE DIE!');
    process.exit(0);
  },

  async ping (context) {
    const [netStub] = context.options._;

    if (!netStub) {
      return 'Not enough arguments!';
    }

    const { network } = matchNetwork(netStub);

    await context.publish({
      type: 'discord:requestPing:irc',
      data: { network }
    });
  },

  uuid (context) {
    let f = uuid.v4;
    if (context.options.v && uuid['v' + context.options.v]) {
      f = uuid['v' + context.options.v];
    }
    return f();
  },

  nanoid () {
    return nanoid();
  },

  rand (context) {
    const length = context.options.length || 16;
    const fmt = context.options.format || 'base64';
    return Buffer.from(Array.from({ length }, () => Math.floor(Math.random() * 0xFF))).toString(fmt);
  },

  debugLogging (context) {
    let prefix = 'En';
    if (context.argObj._[0]) {
      require('../logger').enableLevel('debug');
      console.debug('Debug logging enabled by user!');
      scopedRedisClient((rc, pfx) => rc.publish(pfx + ':__c2::irc:debug_on', JSON.stringify({ type: 'debug_on' })));
    } else {
      require('../logger').disableLevel('debug');
      prefix = 'Dis';
      scopedRedisClient((rc, pfx) => rc.publish(pfx + ':__c2::irc:debug_off', JSON.stringify({ type: 'debug_off' })));
    }

    return `**${prefix}abled** debug logging.`;
  }
};

module.exports = resolver;
