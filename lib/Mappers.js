'use strict';

const fs = require('fs');
const path = require('path');
const config = require('config');

const scopedRedisClient = require('./scopedRedisClient');

class Mapper {
  /* The `path` parameter persists here for legacy reasons but it is no longer
     the primary data source: instead it is used to prime (first run) or
     supplement (later runs) the primary source in Redis. Any entries in the
     `path` file will be added to the Redis store _only if they do not already exist_.
  */
  constructor (path, name) {
    this._path = path;
    this._name = name;
    this._ready = false;
    this._allCache = null;
  }

  _keyForNetwork (prefix, network) {
    return [prefix, 'Mapper', this._name, network].join(':');
  }

  async init () {
    if (this._path) {
      if (process.env.NODE_ENV) {
        const pathComps = path.parse(this._path);
        this._path = path.resolve(path.join(pathComps.dir, `${pathComps.name}-${process.env.NODE_ENV}${pathComps.ext}`));
      }

      if (!fs.existsSync(this._path)) {
        throw new Error(`Mapper given bad path: ${this._path}`);
      }

      const pathContents = JSON.parse(fs.readFileSync(this._path));
      await scopedRedisClient(async (client, prefix) => {
        for (const [network, netDict] of Object.entries(pathContents)) {
          for (const [key, val] of Object.entries(netDict)) {
            await client.hsetnx(this._keyForNetwork(prefix, network), key, JSON.stringify(val));
          }
        }
      });
    }

    this._ready = true;
  }

  async _guardAccess (scopedFn, { isMutator = false } = {}) {
    if (!this._ready) {
      throw new Error('Mapper mutate method called before ready!');
    }

    if (isMutator) {
      this._allCache = null;
    }

    return scopedRedisClient(scopedFn);
  }

  async all () {
    if (this._allCache) {
      return this._allCache;
    }

    return this._guardAccess(async (client, prefix) => {
      const retDict = {};
      const allNets = (await client.keys(this._keyForNetwork(prefix, '*')))
        .map((s) => s.split(':').slice(-1)[0]);

      for (const net of allNets) {
        retDict[net] = await this.forNetwork(net);
      }

      return (this._allCache = retDict);
    });
  }

  async forNetwork (network) {
    const _reducer = (all, preparsed = false) => Object.entries(all ?? {}).reduce(
      (a, [k, vStr]) => ({ [k]: preparsed ? vStr : JSON.parse(vStr), ...a }), {});

    if (this._allCache) {
      return _reducer(this._allCache[network], true);
    }

    return this._guardAccess(async (client, prefix) =>
      _reducer(await client.hgetall(this._keyForNetwork(prefix, network))));
  }

  // does not account for multiple 'key's across networks! take care when using accordingly
  async findNetworkForKey (key) {
    return Object.entries((await this.all())).reduce((a, [network, netMap]) =>
      (Object.entries(netMap).find(([k]) => k === key) ? network : a), null);
  }

  async get (network, key) {
    return JSON.parse(await this._guardAccess(async (client, prefix) =>
      client.hget(this._keyForNetwork(prefix, network), key)));
  }

  async set (network, key, value) {
    return this._guardAccess(async (client, prefix) =>
      client.hset(this._keyForNetwork(prefix, network), key, JSON.stringify(value)), { isMutator: true });
  }

  async remove (network, key) {
    return this._guardAccess(async (client, prefix) =>
      client.hdel(this._keyForNetwork(prefix, network), key), { isMutator: true });
  }
}

const ChannelXforms = new Mapper(config.irc.channelXformsPath, 'ChannelXforms');
const PrivmsgMappings = new Mapper(null, 'PrivmsgMappings');

ChannelXforms.init();
PrivmsgMappings.init();

module.exports = {
  Mapper,
  ChannelXforms,
  PrivmsgMappings
};
