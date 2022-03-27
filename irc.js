'use strict';

const fs = require('fs');
const path = require('path');
const config = require('config');
const irc = require('irc-framework');
const inq = require('inquirer');
const Redis = require('ioredis');
const redisClient = new Redis(config.redis.url);
const { PREFIX, CTCPVersion, scopedRedisClient } = require('./util');
const ipcMessageHandler = require('./irc/ipcMessage');

require('./logger')('irc');

const connectedIRC = {
  bots: {},
  users: {}
};

const msgHandlers = {};

const stats = {
  upSince: new Date(),
  errors: 0,
  discordReconnects: 0,
  latency: {}
};

let allowsBotReconnect = false;
const chanPrefixes = {};

const categories = {};

async function connectIRCClient (connSpec) {
  if (connSpec.account && !connSpec.account.password) {
    const { password } = await inq.prompt({
      type: 'password',
      name: 'password',
      message: `Enter nickserv password for ${connSpec.nick}@${connSpec.host}`
    });

    connSpec.account.password = password;
  }

  if (connSpec.client_certificate && connSpec.client_certificate.fromFile) {
    const certFile = (await fs.promises.readFile(path.resolve(connSpec.client_certificate.fromFile))).toString('utf8');
    const boundaryRe = /-{5}(BEGIN|END)\s(PRIVATE\sKEY|CERTIFICATE)-{5}/g;
    const elems = {
      private_key: {},
      certificate: {}
    };

    for (const match of certFile.matchAll(boundaryRe)) {
      const [boundStr, state, type] = match;
      const typeXform = type.toLowerCase().replace(/\s+/g, '_');

      if (state === 'BEGIN') {
        if (type === 'PRIVATE KEY' && match.index !== 0) {
          throw new Error('pk start');
        }

        elems[typeXform].start = match.index;
      } else if (state === 'END') {
        if (elems[typeXform].start === undefined) {
          throw new Error('bad start!');
        }

        elems[typeXform] = certFile
          .substring(elems[typeXform].start, match.index + boundStr.length);
      }
    }

    if (Object.values(elems).some(x => !x)) {
      throw new Error('bad cert parse');
    }

    connSpec.client_certificate = elems;
  }

  const ircClient = new irc.Client();

  const regPromise = new Promise((resolve, reject) => {
    ircClient.on('registered', resolve.bind(null, ircClient));
  });

  ircClient.on('debug', console.debug);
  connSpec.version = CTCPVersion;
  ircClient.connect(connSpec);
  return regPromise;
}

async function main () {
  console.log(`${PREFIX} IRC bridge started.`);
  const pubClient = new Redis(config.redis.url);
  const specServers = {};
  const ircLogPath = path.join(__dirname, config.irc.log.path);

  if (!fs.existsSync(ircLogPath)) {
    fs.mkdirSync(ircLogPath);
  }

  redisClient.on('message', ipcMessageHandler.bind(null, {
    connectedIRC,
    msgHandlers,
    specServers,
    categories,
    chanPrefixes,
    stats,
    allowsBotReconnect: () => allowsBotReconnect
  }));

  await redisClient.subscribe(PREFIX);

  console.log('Connected to Redis.');
  console.log(`Connecting ${Object.entries(config.irc.registered).length} IRC networks...`);

  const readyData = [];
  for (const [host, serverObj] of Object.entries(config.irc.registered)) {
    const { port, user } = serverObj;

    if (!host || !port) {
      throw new Error('bad server spec', serverObj);
    }

    if (connectedIRC.bots[host]) {
      throw new Error('dupliate server spec', serverObj);
    }

    const spec = {
      host,
      port,
      ...user
    };

    console.log(`Connecting '${spec.nick}' to ${host}...`);
    connectedIRC.bots[host] = await connectIRCClient(spec);

    const logDataToFile = (fileName, data, { isNotice = false, pathExtra = [] } = {}) => {
      console.debug(`logDataToFile(${fileName}, , { isNotice: ${isNotice}, pathExtra: ${pathExtra.join(', ')}})`);
      const chanFileDir = path.join(...[ircLogPath, host, ...pathExtra]);
      const chanFilePath = path.join(chanFileDir, fileName);
      console.debug(`logDataToFile: ${chanFilePath}`);

      fs.stat(chanFileDir, async (err, _stats) => {
        if (err && err.code === 'ENOENT') {
          try {
            await fs.promises.mkdir(chanFileDir, { recursive: true });
          } catch (e) {
            if (e.code !== 'EEXIST') {
              throw e;
            }
          }
        }

        const lData = Object.assign({}, data, {
          __drcLogTs: Number(new Date())
        });

        if (isNotice) console.debug('NOTICE!! Logged', chanFilePath, lData);
        const fh = await fs.promises.open(chanFilePath, 'a');
        await fh.write(JSON.stringify(lData) + '\n');
        fh.close();
      });
    };

    const nickTrack = async (data) => {
      const trimData = Object.assign({}, data);
      delete trimData.__drcNetwork;
      delete trimData.tags;
      trimData.hostname = trimData.hostname.replaceAll(':', '_');
      await scopedRedisClient(async (rc) => {
        const identStr = [trimData.ident, trimData.hostname].join('@');
        const rKey = [PREFIX, host, 'nicktrack', identStr].join(':');
        await rc.sadd([rKey, 'uniques'].join(':'), trimData.nick);
        await rc.sadd([rKey, 'uniques'].join(':'), trimData.new_nick);
        await rc.lpush([rKey, 'changes'].join(':'), JSON.stringify({
          timestamp: Number(new Date()),
          ...trimData
        }));
      });
    };

    ['quit', 'reconnecting', 'close', 'socket close', 'kick', 'ban', 'join',
      'unknown command', 'channel info', 'topic', 'part', 'invited', 'tagmsg',
      'ctcp response', 'ctcp request', 'wallops', 'nick', 'nick in use', 'nick invalid',
      'whois', 'whowas', 'motd', 'info', 'help', 'mode']
      .forEach((ev) => {
        connectedIRC.bots[host].on(ev, async (data) => {
          console.debug('<IRC EVENT>', ev, data);
          if (typeof data !== 'object') {
            console.warn('non-object data!', data);
            return;
          }

          data.__drcNetwork = host;
          const evName = ev.replace(/\s+/g, '_');

          await pubClient.publish(PREFIX, JSON.stringify({
            type: 'irc:' + evName,
            data
          }));

          if (config.irc.log.events?.includes(ev)) {
            logDataToFile(evName, data, { pathExtra: ['event'] });
          }

          if (evName === 'nick') {
            nickTrack(data);
          }
        });
      });

    connectedIRC.bots[host].on('pong', (data) => {
      const nowNum = Number(new Date());
      const splitElems = data.message.split('-');

      if (splitElems.length > 1) {
        const num = Number(splitElems[1]);
        if (!Number.isNaN(num)) {
          stats.latency[host] = nowNum - num;

          if (splitElems[0].indexOf('drc') === 0) {
            pubClient.publish(PREFIX, JSON.stringify({
              type: 'irc:pong',
              data: {
                __drcNetwork: host,
                latencyToIRC: stats.latency[host],
                ...data
              }
            }));
          }
        }
      }
    });

    const noticePubClient = new Redis(config.redis.url);
    connectedIRC.bots[host].on('message', (data) => {
      data.__drcIrcRxTs = Number(new Date());
      data.__drcNetwork = host;

      const isNotice = data.target === spec.nick || data.type === 'notice';

      if (config.irc.log.channelsToFile) {
        const fName = isNotice && data.target === config.irc.registered[host].user.nick /* XXX:really need to keep LIVE track of our nick!! also add !nick DUH */ ? data.nick : data.target;
        logDataToFile(fName, data, { isNotice });
      }

      if (isNotice) {
        noticePubClient.publish(PREFIX, JSON.stringify({
          type: 'irc:notice',
          data
        }));
        return;
      }

      const handler = msgHandlers[host][data.target.toLowerCase()];

      if (!handler) {
        return;
      }

      const { resName, channel, chanPubClient } = handler;

      if (!resName || !channel || !chanPubClient) {
        throw new Error('bad handler', resName, channel);
      }

      chanPubClient.publish(channel, JSON.stringify({
        type: 'irc:message',
        data
      }));
    });

    console.log(`Connected registered IRC bot user ${spec.nick} to ${host}`);
    console.debug('Connected user', connectedIRC.bots[host].user);
    console.debug('Connected network', connectedIRC.bots[host].network);
    readyData.push({
      network: host,
      nickname: spec.nick,
      userModes: connectedIRC.bots[host].user.modes
    });
  }

  process.on('SIGINT', async () => {
    for (const [hn, client] of Object.entries(connectedIRC.bots)) {
      console.log(`quitting ${hn}`);
      let res;
      const prom = new Promise((resolve, reject) => { res = resolve; });
      client.on('close', res);
      client.quit('Quit.');
      await prom;
      console.log(`closed ${hn}`);
    }

    pubClient.publish(PREFIX, JSON.stringify({ type: 'irc:exit' }));
    console.log('Done!');
    process.exit();
  });

  console.log('Ready!');
  pubClient.publish(PREFIX, JSON.stringify({ type: 'irc:ready', data: { readyData } }));
  allowsBotReconnect = true;
}

main();
