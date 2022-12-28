'use strict';

const config = require('config');
const userCommands = require('../userCommands');
const { senderNickFromMessage, messageIsFromAllowedSpeaker } = require('../common');

function createArgObjOnContext (context, data, subaction, noNetworkFirstArg = false) {
  const tmplArr = [senderNickFromMessage(data?.message)];
  if (!noNetworkFirstArg) {
    tmplArr.unshift(context.channelsById[context.channelsById[data?.message.channelId].parent]?.name);
  }

  if (subaction) {
    if (subaction === 'whois') {
      tmplArr.push(data?.message.channelId); // discord channel ID for response
    } else {
      tmplArr.splice(1, 0, subaction);
    }
  }

  context.argObj = { _: tmplArr };
  console.debug('createArgObjOnContext', context.argObj);
  return tmplArr;
}

async function whois (context, data) {
  return userCommands('whois')(context, ...createArgObjOnContext(context, data, 'whois'));
}

async function ignoreAdd (context, data) {
  return userCommands('ignore')(context, ...createArgObjOnContext(context, data, 'add'));
}

async function ignoreRemove (context, data) {
  return userCommands('ignore')(context, ...createArgObjOnContext(context, data, 'remove'));
}

async function muteAdd (context, data) {
  return userCommands('muted')(context, ...createArgObjOnContext(context, data, 'add'));
}

async function muteRemove (context, data) {
  return userCommands('muted')(context, ...createArgObjOnContext(context, data, 'remove'));
}

async function isUserHere (context, data) {
  context.discordMessage = data.message;
  context.isFromReaction = true;
  return userCommands('isUserHere')(context, ...createArgObjOnContext(context, data, null, true));
}

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
  return userCommands('notes')(context, ...args);
}

const allowedReactions = {
  '%F0%9F%87%BC': whois, // "🇼"
  '%E2%9D%94': whois, // "❔"
  '%E2%9D%93': whois, // "❓"

  '%E2%9D%8C': ignoreAdd, // "❌"
  '%E2%9C%96%EF%B8%8F': ignoreAdd, // "✖️"
  '%F0%9F%87%BD': ignoreAdd, // "🇽"
  '%E2%9B%94': ignoreAdd, // "⛔"
  '%F0%9F%9A%AB': ignoreAdd, // "🚫"

  '%E2%9E%96': ignoreRemove, // "➖"

  '%F0%9F%97%92%EF%B8%8F': makeNoteOfMessage, // "🗒️"
  '%F0%9F%93%93': makeNoteOfMessage, // "📓"

  '%F0%9F%94%87': muteAdd, // "🔇"
  '%F0%9F%94%95': muteAdd, // "🔕"

  '%F0%9F%94%8A': muteRemove, // "🔊"
  '%F0%9F%94%89': muteRemove, // "🔉"

  '%F0%9F%8F%A0': isUserHere, // "🏠"
  '%F0%9F%8F%98%EF%B8%8F': isUserHere // "🏘️"
};

const reactionsToRemove = [];
let ritHandle;

// serialize reaction removals because the rate limit is extremely tight
const _removeInTime = () => {
  if (ritHandle) {
    return;
  }

  ritHandle = setTimeout(() => {
    ritHandle = null;
    const firstToRm = reactionsToRemove.shift();
    console.debug('_removeInTime RM', firstToRm?.message.id);
    firstToRm.remove();
    if (reactionsToRemove.length) {
      console.debug('_removeInTime have', reactionsToRemove.length);
      _removeInTime();
    }
  }, config.discord.reactionRemovalTimeMs);
};

const removeReactionInTime = (messageReaction) => {
  console.debug('removeReactionInTime', messageReaction?.message.id);
  reactionsToRemove.push(messageReaction);
  _removeInTime();
};

module.exports = async (context, messageReaction, author, ...a) => {
  console.debug('messageReactionAdd', a);
  console.debug(author);
  console.debug(messageReaction);
  const removeInTime = removeReactionInTime.bind(null, messageReaction);
  if (author.id === config.discord.botId) {
    return removeInTime();
  }

  console.debug(messageReaction.users.reaction?.emoji?.name, 'is', messageReaction.users.reaction?.emoji?.identifier);

  if (!messageIsFromAllowedSpeaker({ author }, context)) {
    console.error('can NOT?! use reaction!', author);
    return messageReaction.remove();
  }

  const retVal = allowedReactions?.[messageReaction.users.reaction?.emoji?.identifier]?.(context, messageReaction, author);

  if (retVal) {
    messageReaction.message.react('✅');
    removeInTime();
  } else {
    return messageReaction.remove();
  }
};
