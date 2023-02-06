'use strict';

const path = require('path');
const {
  PREFIX,
  AmbiguousMatchResultError,
  matchNetwork,
  scopedRedisClient,
  userFirstSeen,
  userLastSeen
} = require('../util');
const {
  dynRequireFrom,
  generateListManagementUCExport,
  clearSquelched,
  digest,
  getNetworkAndChanNameFromUCContext
} = require('./common');

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
    if (f) {
      f.__resolvedFullCommandName = matches[0];
    }
  }

  scopedRedisClient(async (client, prefix) => {
    await client.zincrby([prefix, 'userCommandResolver'].join(':'), '1',
      functionName ?? f.__resolvedFullCommandName ?? '__unresolved__' + functionName);
  });

  return f;
}

resolver.__unrequireCommands = function () {
  [
    '../util',
    './common',
    './plotting',
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

  identsIgnored: generateListManagementUCExport('identsIgnored'),

  hilite: generateListManagementUCExport('hilite'),

  onConnect: generateListManagementUCExport('onConnect'),

  muted: generateListManagementUCExport('muted', { clearSquelched, digest }, false, 'ignore'),

  aliveChecks: generateListManagementUCExport('aliveChecks', {
    listAllNetworks: () => scopedRedisClient(async (client, PREFIX) =>
      (await client.keys(`${PREFIX}:aliveChecks:*`)).map(x => x.split(':')).map(x => x.pop()))
  }),

  siteChecks: generateListManagementUCExport('siteChecks', {
    listAllNetworks: () => scopedRedisClient(async (client, PREFIX) =>
      (await client.keys(`${PREFIX}:siteChecks:*`)).map(x => x.split(':')).map(x => x.pop()))
  }),

  killmenow: () => process.exit(-1),

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

  digest: (context) => {
    if (context.options._.length !== 2) {
      return;
    }

    const [network, minutes] = context.options._;
    context.options._ = [network, 'digest', minutes];
    return resolver('logs')(context);
  },

  userFirstSeen: async (context) => {
    const { network } = getNetworkAndChanNameFromUCContext(context);
    if (network) {
      return (await userFirstSeen(network, context.options))[0];
    } else {
      return `Unknown network ${network}`;
    }
  },

  userLastSeen: async (context) => {
    const { network } = getNetworkAndChanNameFromUCContext(context);
    if (network) {
      return (await userLastSeen(network, context.options))[0];
    } else {
      return `Unknown network ${network}`;
    }
  }
};

module.exports = resolver;
