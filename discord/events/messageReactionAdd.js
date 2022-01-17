'use strict';

const config = require('config');
const userCommands = require('../userCommands');
const { senderNickFromMessage, messageIsFromAllowedSpeaker } = require('../common');

async function whois (context, data) {
  context.argObj = {
    _: [ /// XXX fix this
      context.channelsById[context.channelsById[data?.message.channelId].parent].name,
      senderNickFromMessage(data?.message)
    ]
  };

  return userCommands('whois')(context, ...context.argObj._);
}

async function ignoreAdd (context, data) {
  context.argObj = {
    _: [ /// XXX fix this
      context.channelsById[context.channelsById[data?.message.channelId].parent].name,
      'add',
      senderNickFromMessage(data?.message)
    ]
  };

  return userCommands('ignore')(context, ...context.argObj._);
}

async function ignoreRemove (context, data) {
  context.argObj = {
    _: [ /// XXX fix this
      context.channelsById[context.channelsById[data?.message.channelId].parent].name,
      'remove',
      senderNickFromMessage(data?.message)
    ]
  };

  return userCommands('ignore')(context, ...context.argObj._);
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
