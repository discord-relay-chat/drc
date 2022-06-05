'use strict';

const config = require('config');
const userCommands = require('../userCommands');
const { senderNickFromMessage, messageIsFromAllowedSpeaker } = require('../common');

function createArgObjOnContext (context, data, subaction) {
  const network = context.channelsById[context.channelsById[data?.message.channelId].parent]?.name;
  const tmplArr = [
    network,
    senderNickFromMessage(data?.message) // nick
  ];

  if (subaction) {
    if (subaction === 'whois') {
      tmplArr.push(data?.message.channelId); // discord channel ID for response
    } else {
      tmplArr.splice(1, 0, subaction);
    }
  }

  context.argObj = { _: tmplArr };
  console.log('createArgObjOnContext', context.argObj);
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

const allowedReactions = {
  '%F0%9F%87%BC': whois, // "🇼"
  '%E2%9D%94': whois, // "❔"
  '%E2%9D%93': whois, // "❓"

  '%E2%9D%8C': ignoreAdd, // "❌"
  '%E2%9C%96%EF%B8%8F': ignoreAdd, // "✖️"
  '%F0%9F%87%BD': ignoreAdd, // "🇽"
  '%E2%9B%94': ignoreAdd, // "⛔"
  '%F0%9F%9A%AB': ignoreAdd, // "🚫",

  '%E2%9E%96': ignoreRemove // "➖"
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

module.exports = async (context, messageReaction, author) => {
  const removeInTime = removeReactionInTime.bind(null, messageReaction);
  if (author.id === config.discord.botId) {
    return removeInTime();
  }

  console.log(messageReaction.users.reaction?.emoji?.name, 'is', messageReaction.users.reaction?.emoji?.identifier);

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
