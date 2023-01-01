'use strict';

const Redis = require('ioredis');
const config = require('./config');
const child_process = require('child_process'); // eslint-disable-line camelcase
const { PREFIX, scopedRedisClient } = require('./util');
const { nanoid } = require('nanoid');
const {
  NewSpawnEvents,
  RemoteEventListener,
  HOST_REQUEST_CHANNEL_SUFFIX,
  HOST_SPAWNED_EVENT_CHAN_MID
} = require('./host');

function drcChildProcessStdinWrite (data) {
  const { drcPid } = this;
  scopedRedisClient(async (client, prefix) => {
    await client.publish(prefix + HOST_SPAWNED_EVENT_CHAN_MID + drcPid + ':stdin:data', JSON.stringify({
      eventName: 'data',
      eventParams: data
    }));
  });
}

class DRCChildProcess {
  constructor (binary, args = []) {
    this.args = args;
    this.binary = binary;
    this.drcPid = nanoid();
    this.closeEventUserHandler = null;
    this.channelNamePrefix = PREFIX + HOST_SPAWNED_EVENT_CHAN_MID + this.drcPid;

    this.mainEventRegistrar = new RemoteEventListener(this.channelNamePrefix);
    this.mainEventRegistrar.on('close', (...args) => {
      console.log('Remote process', this.drcPid, 'closed: cleaning up & acking');
      this.closeEventUserHandler?.(...args);

      this.mainEventRegistrar.close();
      NewSpawnEvents.filehandles.names.forEach((fhName) => this[fhName].close());

      scopedRedisClient(async (client, prefix) => {
        await client.publish(prefix + HOST_REQUEST_CHANNEL_SUFFIX, JSON.stringify({
          type: 'clientAckClose',
          data: { drcPid: this.drcPid }
        }));
      });
    });

    NewSpawnEvents.filehandles.names.forEach((fhName) => {
      this[fhName] = new RemoteEventListener(this.channelNamePrefix, ':' + fhName);
    });

    this.stdin = { write: drcChildProcessStdinWrite.bind(this) };
  }

  on (event, callback) {
    if (event === 'close') {
      this.closeEventUserHandler = callback;
      return;
    }

    return this.mainEventRegistrar.on(event, callback);
  }

  disconnect () {
    // need to define & send a "requestDisconnect" event!
  }

  spawn () {
    setImmediate(() => {
      const client = new Redis(config.redis.url);
      client.publish(PREFIX + HOST_REQUEST_CHANNEL_SUFFIX, JSON.stringify({
        type: 'requestSpawn',
        data: {
          drcPid: this.drcPid,
          binary: this.binary,
          args: this.args
        }
      }))
        .finally(() => client.disconnect());
    });

    return this;
  }

  get pid () {
    // yeah this doesn't match child_process.ChildProcess semantics at all... or POSIX
    // i checked and they'd never need (and fail) to be coerced to integers anywhere so :shrug:
    return this.drcPid;
  }
}

/**
 This method follows the semantics of child_process.spawn() but only as long
  as it and the associated .on event handler registrations are done in the
  same synchronous block of code. If the event loop is allowed to run _even once_,
  the process will be spawned and any event data discarded!
  **/
function spawn (binary, args = []) {
  if (!config.hostDaemon.enabled) {
    console.warn('Falling back to local spawn() because host daemon is not enabled!');
    return child_process.spawn(binary, args);
  }

  return (new DRCChildProcess(binary, args)).spawn();
}

module.exports = {
  DRCChildProcess,
  spawn
};
