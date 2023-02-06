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

  const discName = await resolveNameForDiscord(parsed.data.network, parsed.data.channel.name);
  const discId = channelsByName[parsed.data.network][discName];
  const [chanSpec] = categoriesByName[parsed.data.network]
    .map((catId) => categories[catId].channels[discId]).filter(x => !!x);

  console.debug('(UL) CHAN SPEC', chanSpec, 'for', parsed.data);

  parsed.data.__othHelpers = {
    msgChan: client.channels.cache.get(chanSpec.id)
  };

  console.debug('USER LIST!!', parsed.data, discName, chanSpec);
  await runOneTimeHandlers(parsed.data.channel.name);
};
