'use strict';

const notesCommand = require('./userCommands/notes');
const { createArgObjOnContext } = require('./common');

require('../logger')('discord');

async function makeNoteOfMessage (context, data) {
  console.debug('makeNoteOfMessage');
  if (!data?.message?.content) {
    console.error('Bad data for makeNoteOfMessage:', data);
    return;
  }
  let args = createArgObjOnContext(context, data);
  const msg = `"${data?.message?.content}"` +
    ` (captured in **${args[0]}/#${context.channelsById[data?.message?.channelId].name}**` +
    ` at _${new Date(data?.message?.createdTimestamp).toDRCString()}_)`;
  args = [...args, 'add', msg];
  console.debug(args);
  console.debug(msg);
  context.options = { _: args };
  context.argObj._ = args;
  await notesCommand(context, ...args);
  return msg;
}

module.exports = {
  makeNoteOfMessage
};
