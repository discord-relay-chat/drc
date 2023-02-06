require('../logger')('liveNicks');

class Nick {
  constructor (initialNick, mergedHistory = []) {
    this.nicks = [...mergedHistory];
    if (initialNick) {
      this.add(initialNick);
    }
  }

  add (nick) {
    if (nick !== this.nicks[0]) {
      this.nicks.unshift(nick);
      return true;
    }

    return false;
  }

  get current () {
    return this.nicks[0];
  }

  wasOnce (historicalNick) {
    return this.nicks.some(nick => nick === historicalNick);
  }

  history () {
    return [...this.nicks];
  }
}

module.exports = class LiveNicks {
  constructor (fromList, mergeHistoryFrom) {
    this.nicks = {};
    if (fromList) {
      this.nicks = fromList.reduce((a, nick) => ({
        [nick]: new Nick(nick, mergeHistoryFrom?.get(nick)?.history() ?? []),
        ...a
      }), {});
    }
  }

  add (nick) {
    if (!this.nicks[nick]) {
      this.nicks[nick] = new Nick();
    }

    return this.nicks[nick].add(nick);
  }

  delete (nick) {
    if (this.nicks[nick]) {
      delete this.nicks[nick];
      return true;
    }

    return false;
  }

  swap (oldNick, newNick) {
    const nickObj = this.nicks[oldNick];

    if (!nickObj) {
      return false;
    }

    this.nicks[newNick] = nickObj;
    delete this.nicks[oldNick];
    return nickObj.add(newNick);
  }

  has (nick) {
    return this.nicks[nick] !== undefined;
  }

  had (historicalNick) {
    const oldNicks = Object.values(this.nicks).filter(nickObj => nickObj.wasOnce(historicalNick));

    if (!oldNicks.length) {
      return null;
    }

    return oldNicks.map(nickObj => nickObj.current);
  }

  size () {
    return Object.keys(this.nicks).length;
  }

  get (nick) {
    return this.nicks[nick];
  }
};
