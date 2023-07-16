const scopedRedisClient = require('./scopedRedisClient');

// probably need to error-check the redis call results in methods that do that,
// and before making changes to the internal this._set cache...

module.exports = class RedisSet {
  constructor (setKey) {
    this.setKey = setKey;
    this._set = new Set();
    this._init = false;
  }

  _key (prefix) { return prefix + ':' + this.setKey + '::RedisSet'; }

  _requireInit () {
    if (!this._init) {
      throw new Error(`RedisSet<${this.setKey}> used before init() called!`);
    }
  }

  async init () {
    if (this._init) {
      return false;
    }

    this._set = new Set(await scopedRedisClient((client, PREFIX) =>
      client.smembers(this._key(PREFIX))
    ));

    return (this._init = true);
  }

  async add (member) {
    this._requireInit();
    await scopedRedisClient((client, PREFIX) => client.sadd(this._key(PREFIX), member));
    return this._set.add(member);
  }

  async delete (member) {
    this._requireInit();
    await scopedRedisClient((client, PREFIX) => client.srem(this._key(PREFIX), member));
    return this._set.delete(member);
  }

  has (member) {
    this._requireInit();
    return this._set.has(member);
  }
};
