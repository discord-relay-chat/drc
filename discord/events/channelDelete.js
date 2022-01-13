'use strict';

const config = require('config');
const { PREFIX } = require('../../util');
const Redis = require('ioredis');

module.exports = async (context, data) => {
  const {
    categories,
    deletedBeforeJoin
  } = context;

  const { name, parentId } = data;
  const parentCat = categories[parentId];

  if (!deletedBeforeJoin[name]) {
    const c = new Redis(config.redis.url);
    await c.publish(PREFIX, JSON.stringify({
      type: 'discord:deleteChannel',
      data: {
        name,
        network: parentCat.name
      }
    }));
    c.disconnect();
  } else {
    console.log(`Removed channel ${name} (ID: ${deletedBeforeJoin[name]}) before join`);
    delete deletedBeforeJoin[name];
  }
};
