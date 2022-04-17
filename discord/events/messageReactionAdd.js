'use strict';

const config = require('config');
const userCommands = require('../userCommands');
const { senderNickFromMessage, messageIsFromAllowedSpeaker } = require('../common');

function createArgObjOnContext (context, data, subaction) {
  const network = context.channelsById[context.channelsById[data?.message.channelId].parent]?.name;
  const tmplArr = [
    network,
    senderNickFromMessage(data?.message), // nick
    data?.message.channelId // discord channel id
  ];

  if (subaction) {
    tmplArr.splice(1, 0, subaction);
  }

  context.argObj = { _: tmplArr };
  console.log('createArgObjOnContext', context.argObj);
  return tmplArr;
}

async function whois (context, data) {
  return userCommands('whois')(context, ...createArgObjOnContext(context, data));
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

module.exports = async (context, messageReaction, author) => {
  const removeInTime = () => setTimeout(() => messageReaction.remove(), config.discord.reactionRemovalTimeMs);
  if (author.id === config.discord.botId) {
    return removeInTime();
  }

  console.log(messageReaction.users.reaction?.emoji?.name, 'is', messageReaction.users.reaction?.emoji?.identifier);

  if (!messageIsFromAllowedSpeaker({ author }, context)) {
    console.log('can NOT?! use reaction!', author);
    messageReaction.message.react('❌');
    return messageReaction.remove();
  }

  const retVal = allowedReactions?.[messageReaction.users.reaction?.emoji?.identifier]?.(context, messageReaction, author);

  if (retVal) {
    messageReaction.message.react('✅');
    removeInTime();
  } else {
    messageReaction.remove();
  }
};
