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

resolver.init = async function (isReload = false, oldScriptsContext) {
  return Promise.all(Object.entries(resolver.__functions).map(async ([name, f]) => {
    if (f.__init) {
      try {
        await f.__init(isReload, oldScriptsContext);
        console.info(`userCommand "${name}" initialized`);
      } catch (e) {
        console.error(`userCommand "${name}" __init failed!`, e);
      } finally {
        // only let it run once with the (usually correct) assumption that
        // it will continue to fail if called repeatedly
        delete f.__init(isReload, oldScriptsContext);
      }
    }
  }));
};

// Add __drcHelp to commands that don't have it
const psHelp = () => ({
  title: 'Show process status for IRC component',
  usage: '',
  notes: 'Displays process information for the IRC component of the system.'
});
resolver.__functions.ps.__drcHelp = psHelp;

const killmenowHelp = () => ({
  title: 'Immediately terminate the bot process',
  usage: '',
  notes: 'WARNING: This command will cause the bot to exit immediately with a non-zero exit code.'
});
resolver.__functions.killmenow.__drcHelp = killmenowHelp;

const pingHelp = () => ({
  title: 'Ping an IRC network',
  usage: 'network',
  notes: 'Pings the specified IRC network to check connectivity.'
});
resolver.__functions.ping.__drcHelp = pingHelp;

const digestHelp = () => ({
  title: 'Generate a message digest',
  usage: 'network minutes',
  notes: 'Creates a digest of messages from the specified network within the given time frame in minutes.'
});
resolver.__functions.digest.__drcHelp = digestHelp;

const userFirstSeenHelp = () => ({
  title: 'Show when a user was first seen',
  usage: 'nickname',
  notes: 'Displays the timestamp when a user was first seen on the current network.'
});
resolver.__functions.userFirstSeen.__drcHelp = userFirstSeenHelp;

const userLastSeenHelp = () => ({
  title: 'Show when a user was last seen',
  usage: 'nickname',
  notes: 'Displays the timestamp when a user was last seen on the current network.'
});
resolver.__functions.userLastSeen.__drcHelp = userLastSeenHelp;

module.exports = resolver;
