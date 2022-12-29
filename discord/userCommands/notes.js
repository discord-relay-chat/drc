'use strict';

const { scopedRedisClient } = require('../../util');
const { generatePerChanListManagementUCExport, simpleEscapeForDiscord } = require('../common');

module.exports = generatePerChanListManagementUCExport('notes', {
  listAll: async (context, ...a) => scopedRedisClient(async (client, prefix) => {
    console.log('listAll', context.network, `${prefix}:notes_${context.network}_*`);
    const netList = await client.keys(`${prefix}:notes_${context.network}_*`);
    console.log(`got list of ${netList.length}`);
    return 'Full list of notes:\n\n• ' + netList.sort().map(x => simpleEscapeForDiscord(x.split(':')[1].split('_').slice(2).join('_'))).join('\n• ');
  })
}, false);
