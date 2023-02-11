'use strict';

const { ChannelXforms } = require('./Mappers');

function _resolveNameForIRC (xforms, name) {
  return (xforms && xforms[name]) || name;
}

async function resolveNameForIRC (network, name) {
  return _resolveNameForIRC(await ChannelXforms.forNetwork(network), name);
}

function resolveNameForIRCSyncFromCache (allCache, network, name) {
  return _resolveNameForIRC(allCache[network], name);
}

async function resolveNameForDiscord (network, ircName) {
  const resolverRev = Object.entries(await ChannelXforms.all()).reduce((a, [network, nEnt]) => {
    return { [network]: Object.entries(nEnt).reduce((b, [k, v]) => ({ [v]: k, ...b }), {}), ...a };
  }, {});

  return ((network && ircName && (resolverRev && resolverRev[network] &&
    resolverRev[network][ircName.toLowerCase().slice(1)])) || ircName.replace(/^#/, '')).toLowerCase();
}

module.exports = {
  resolveNameForIRC,
  resolveNameForIRCSyncFromCache,
  resolveNameForDiscord
};
