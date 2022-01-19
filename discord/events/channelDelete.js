'use strict';

const config = require('config');
const { PREFIX, PrivmsgMappings } = require('../../util');
const Redis = require('ioredis');

module.exports = async (context, data) => {
  const {
    categories,
    deletedBeforeJoin
  } = context;

  const { name, id, parentId } = data;
  const parentCat = categories[parentId];

  console.log('REMOVE!', PrivmsgMappings.findNetworkForKey(id), id, name);
  PrivmsgMappings.remove(PrivmsgMappings.findNetworkForKey(id), id);

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
