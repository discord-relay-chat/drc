'use strict';

const {
  resolveNameForDiscord
} = require('../../util');

module.exports = async function (parsed, context) {
  const {
    client,
    categories,
    categoriesByName,
    channelsByName,
    runOneTimeHandlers
  } = context;

  const discName = resolveNameForDiscord(parsed.data.network, parsed.data.channel.name);
  const chanSpec = categories[categoriesByName[parsed.data.network]].channels[channelsByName[parsed.data.network][discName]];

  parsed.data.__othHelpers = {
    msgChan: client.channels.cache.get(chanSpec.id)
  };

  console.debug('USER LIST!!', parsed.data, discName, chanSpec);
  await runOneTimeHandlers(parsed.data.channel.name);
};
