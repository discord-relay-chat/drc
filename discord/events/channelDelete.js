'use strict';

const config = require('config');
const { PREFIX, PrivmsgMappings } = require('../../util');
const { removePmChan } = require('../common');
const Redis = require('ioredis');

module.exports = async (context, data) => {
  const {
    categories,
    deletedBeforeJoin
  } = context;

  const { name, id, parentId } = data;
  const parentCat = categories[parentId];

  if (parentId === config.discord.privMsgCategoryId) {
    const network = PrivmsgMappings.findNetworkForKey(id);
    PrivmsgMappings.remove(network, id);
    return removePmChan(network, id);
  }

  if (!deletedBeforeJoin[name]) {
    const c = new Redis(config.redis.url);
    await c.publish(PREFIX, JSON.stringify({
      type: 'discord:deleteChannel',
      data: {
        name,
        network: parentCat.name,
        isPrivMsgChannel: parentId === config.discord.privMsgCategoryId
      }
    }));
    c.disconnect();
  } else {
    console.log(`Removed channel ${name} (ID: ${deletedBeforeJoin[name]}) before join`);
    delete deletedBeforeJoin[name];
  }
};
