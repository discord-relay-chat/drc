'use strict';

const config = require('config');
const userCommands = require('../userCommands');
const { messageIsFromAllowedSpeaker, createArgObjOnContext } = require('../common');
const { makeNoteOfMessage } = require('../interactionsCommon');

async function whois(context, data) {
  return userCommands('whois')(context, ...createArgObjOnContext(context, data, 'whois'));
}

async function ignoreAdd(context, data) {
  return userCommands('ignore')(context, ...createArgObjOnContext(context, data, 'add'));
}

async function ignoreRemove(context, data) {
  return userCommands('ignore')(context, ...createArgObjOnContext(context, data, 'remove'));
}

async function muteAdd(context, data) {
  return userCommands('muted')(context, ...createArgObjOnContext(context, data, 'add'));
}

async function muteRemove(context, data) {
  return userCommands('muted')(context, ...createArgObjOnContext(context, data, 'remove'));
}

async function isUserHere(context, data) {
  context.discordMessage = data.message;
  context.isFromReaction = true;
  return userCommands('isUserHere')(context, ...createArgObjOnContext(context, data, null, true));
}

async function aiQuestion(aiName, context, data) {
  return userCommands(aiName)({ 
    ...context, 
    options: { 
      ...context.options, 
      system: (context.options?.system ?? '') + config.genai.emojiReactionSystemPrompt 
    }, 
    argObj: { _: data.message.content.split(' ') } 
  });
}

const allowedReactions = {
  '%F0%9F%87%AC': aiQuestion.bind(null, 'gpt'), // "🇬"
  '%F0%9F%A4%94': aiQuestion.bind(null, 'claude'), // "🤔"

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
