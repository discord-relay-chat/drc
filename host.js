'use strict';

const Redis = require('ioredis');
const config = require('./config');
const { PREFIX, scopedRedisClient, isXRunning, isXRunningRequestListener } = require('./util');
const { spawn } = require('child_process');

require('./logger')('host');

class RemoteEventListener {
  constructor (channelNamePrefix, channelNamePostfix = '') {
    this.channelNamePrefix = channelNamePrefix;
    this.channelNamePostfix = channelNamePostfix;
    this.clients = [];
  }

  on (event, callback) {
    const regChannel = this.channelNamePrefix + this.channelNamePostfix + ':' + event;
    const evClient = new Redis(config.redis.url);
    this.clients.push(evClient);
    console.debug(`RemoteEventListener listening on ${regChannel}`);
    evClient.subscribe(regChannel, (err) => {
      if (err) {
        throw err; // should handle better...
      }

      evClient.on('message', (channel, messageText) => {
        try {
          const { eventName, eventParams } = JSON.parse(messageText);
          if (eventName === event) {
            setImmediate(callback.bind(null, eventParams));
          }
        } catch (e) {
          console.error(`Malformed DRCChildProcess (PID: ${this.drcPid}) message "${messageText}"`, e.message);
          console.debug(e);
        }
      });
    });
  }

  close () {
    console.debug(`REL<${this.channelNamePrefix + this.channelNamePostfix}>.close() has ${this.clients.length} clients`);
    this.clients.forEach((client) => client.disconnect());
  }
}

const HOST_REQUEST_CHANNEL_SUFFIX = ':hostRequestChannel';
const HOST_SPAWNED_EVENT_CHAN_MID = ':host:spawnedProcessEvent:';

const NewSpawnEvents = {
  process: {
    events: ['disconnect', 'close', 'error', 'exit', 'message', 'spawn']
  },
  filehandles: {
    names: ['stdout', 'stderr'],
    events: ['data', 'close']
  }
};

const RunningProcesses = {};

function cleanupRunningProcess (drcPid) {
  if (!RunningProcesses[drcPid]) {
    console.error(`cleanupRunningProcess PID ${drcPid} does not exist!`);
    return;
  }

  const { client, listener } = RunningProcesses[drcPid];
  client.disconnect();
  listener.close();
  delete RunningProcesses[drcPid];
}

const MessageHandlers = {
  requestSpawn (data) {
    const { drcPid, binary, args } = data;

    if (!config.hostDaemon.whitelistedBinaries.includes(binary)) {
      return 'Binary not allowed';
    }

    const process = spawn(binary, args);
    const client = new Redis(config.redis.url);
    const listener = new RemoteEventListener(PREFIX + HOST_SPAWNED_EVENT_CHAN_MID + drcPid, ':stdin');
    RunningProcesses[drcPid] = { process, client, listener };

    listener.on('data', (data) => process.stdin.write(data));

    NewSpawnEvents.process.events.forEach((eventName) => {
      process.on(eventName, (...eventParams) => {
        if (eventName === 'error') {
          console.error(`Spawned process PID ${drcPid} ERROR:`, eventParams);
        }

        if (eventName === 'spawn') {
          eventParams.push(process.pid);
        }

        client.publish(PREFIX + HOST_SPAWNED_EVENT_CHAN_MID + drcPid + ':' + eventName,
          JSON.stringify({ eventName, eventParams }));
      });
    });

    NewSpawnEvents.filehandles.names.forEach((fhName) => {
      NewSpawnEvents.filehandles.events.forEach((eventName) => {
        process[fhName].on(eventName, (...eventParams) => {
          const chanName = PREFIX + HOST_SPAWNED_EVENT_CHAN_MID + drcPid + ':' + fhName + ':' + eventName;
          if (eventParams.length === 1 && eventParams[0] instanceof Buffer) {
            eventParams = eventParams[0].toString('utf-8');
          }
          client.publish(chanName, JSON.stringify({ eventName, eventParams }));
        });
      });
    });

    console.log(`Spawned "${[binary, ...args].join(' ')}" as PID ${drcPid}`);
  },

  // we cannot discard the requisite instances until after the _client-side_ has
  // acknowledged receipt of the close event
  clientAckClose (data) {
    const { drcPid } = data;
    console.log('Close event acknowledged for PID', drcPid);
    cleanupRunningProcess(drcPid);
  }
};

function handleMessage (messageText) {
  try {
    const { type, data } = JSON.parse(messageText);
    if (!MessageHandlers[type]) {
      throw new Error(`Programming error: no handler for message type "${type}"!`);
    }
    const handlerRet = MessageHandlers[type](data);
    if (handlerRet) {
      console.error(`Handler for message type "${type}" returned error:`, handlerRet);
    }
  } catch (e) {
    console.error(`Badly-formed message "${messageText}":`, e.message);
    console.debug(e);
  }
}

async function main () {
  if (!config.hostDaemon.enabled) {
    console.warn('Host daemon is not enabled! Exiting.');
    return;
  }

  let sigPromFuncs;
  const sigProm = new Promise((resolve, reject) => (sigPromFuncs = { resolve, reject }));
  function sigHandler (signal) {
    sigPromFuncs.resolve(signal);
  }

  process.on('SIGINT', sigHandler);
  process.on('SIGHUP', sigHandler);

  await scopedRedisClient(async (client, prefix) => {
    const isRunningListener = await isXRunningRequestListener('Host', async (data) => {
      const { reqId } = data;
      console.log('isHostRunningRequest reqId', reqId);
      await scopedRedisClient(async (innerClient) =>
        innerClient.publish(prefix, JSON.stringify({
          type: 'http:isHostRunningResponse',
          data: { reqId }
        })));
    });

    const channel = prefix + HOST_REQUEST_CHANNEL_SUFFIX;
    client.subscribe(channel, (err) => {
      if (err) {
        console.error(`Redis subscribe to channel "${channel}" failed:`, err);
        return sigPromFuncs.reject(err);
      }

      client.on('message', (_channel, messageText) => handleMessage(messageText));
    });

    console.log(`Listening on channel "${channel}"...`);
    const signal = await sigProm;
    isRunningListener.disconnect();
    console.log(`Ended with signal ${signal}`);

    Object.keys(RunningProcesses).forEach((drcPid) => {
      console.log(`Cleaning up stale running process PID ${drcPid}...`);
      cleanupRunningProcess(drcPid);
    });
  });
}

if (require.main === module) {
  main();
} else {
  module.exports = {
    NewSpawnEvents,
    RemoteEventListener,

    HOST_REQUEST_CHANNEL_SUFFIX,
    HOST_SPAWNED_EVENT_CHAN_MID,

    isHostRunning: isXRunning.bind(null, 'Host')
  };
}
