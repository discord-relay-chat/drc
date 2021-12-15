const fs = require('fs');
const path = require('path');
const uuid = require('uuid');
const { PREFIX, AmbiguousMatchResultError, matchNetwork } = require('../util');
const { generateListManagementUCExport } = require('./common');

const MODULENAME = path.join(__dirname, path.parse(__filename).name);

const fileExportReqdPaths = [];
const fileExportsPath = path.join(__dirname, path.parse(__filename).name);
const fileExports = fs.readdirSync(fileExportsPath)
  .reduce((a, dirEnt) => {
    const fPath = path.join(fileExportsPath, dirEnt);
    const fParsed = path.parse(fPath);

    if (!fs.statSync(fPath).isDirectory() && fParsed.ext === '.js') {
      fileExportReqdPaths.push(fPath);
      return {
        [fParsed.name]: require(fPath),
        ...a
      };
    }

    return a;
  }, {});

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
    .forEach((fPath) => (delete require.cache[require.resolve(fPath)]));
};

resolver.__unresolve = function () {
  require(MODULENAME).__unrequireCommands();
  delete require.cache[require.resolve(MODULENAME)];
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

  rand (context) {
    const length = context.options.length || 16;
    const fmt = context.options.format || 'base64';
    return Buffer.from(Array.from({ length }, () => Math.floor(Math.random() * 0xFF))).toString(fmt);
  }
};

module.exports = resolver;
