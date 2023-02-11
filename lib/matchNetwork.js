'use strict';

const config = require('config');
const { AmbiguousMatchResultError, NetworkNotMatchedError } = require('./Errors');

module.exports = {
  matchNetwork (network, options = { returnScores: false }) {
    const ret = {};

    if (!config.irc.registered[network]) {
      const scored = Object.keys(config.irc.registered)
        .map(rn => [rn.indexOf(network), rn])
        .filter(x => x[0] !== -1)
        .sort((a, b) => a[0] - b[0]);

      if (scored.length && scored[0].length) {
        if (scored.length > 1 && scored[0][0] === scored[1][0]) {
          throw new AmbiguousMatchResultError(network, ' -- Scores: ' + JSON.stringify(scored));
        }

        network = scored[0][1];

        if (options.returnScores) {
          ret.scores = scored;
        }
      } else {
        throw new NetworkNotMatchedError(network);
      }
    }

    return { network, ...ret };
  }
};
