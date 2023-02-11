'use strict';

// for the record i'm annoyed that using exceptions for control flow here
// is easier so i'm doing it, but it is so ia m

class AmbiguousMatchResultError extends Error {
  constructor (msg) {
    super(msg);
    this.name = this.constructor.name;
  }
}

class NetworkNotMatchedError extends Error {
  constructor (msg) {
    super(msg);
    this.name = this.constructor.name;
  }
}

class UserCommandNotFound extends Error {
  constructor (msg) {
    super(msg);
    this.name = this.constructor.name;
  }
}

module.exports = {
  AmbiguousMatchResultError,
  NetworkNotMatchedError,
  UserCommandNotFound
};
