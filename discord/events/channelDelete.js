'use strict';

const config = require('config');
const { PREFIX, PrivmsgMappings, scopedRedisClient } = require('../../util');
const { removePmChan } = require('../common');

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
    await scopedRedisClient(async (c) => {
      await c.publish(PREFIX, JSON.stringify({
        type: 'discord:deleteChannel',
        data: {
          name,
          network: parentCat.name,
          isPrivMsgChannel: parentId === config.discord.privMsgCategoryId
        }
      }));
    });
  } else {
    console.log(`Removed channel ${name} (ID: ${deletedBeforeJoin[name]}) before join`);
    delete deletedBeforeJoin[name];
  }
};
