'use strict';

const { resolveNameForIRC } = require('../../util');
const { MessageMentions: { CHANNELS_PATTERN } } = require('discord.js');

async function convertDiscordChannelsToIRCInString (targetString, context, network) {
  if (targetString.match(CHANNELS_PATTERN)) {
    const [chanMatch, channelId] = [...targetString.matchAll(CHANNELS_PATTERN)][0];
    const ircName = '#' + await resolveNameForIRC(network, context.getDiscordChannelById(channelId).name);
    targetString = targetString.replace(chanMatch, ircName);
  }
  return targetString;
}

const discordEscapeRx = /([*_`])/g;
function simpleEscapeForDiscord (s) {
  if (typeof (s) !== 'string' || s.length === 0) {
    return s;
  }

  if (s.indexOf('\\') !== -1) {
    // assume any escape in `s` means it has already been escaped
    return s;
  }

  let lastIndex = 0;
  let accum = '';

  for (const match of [...s.matchAll(discordEscapeRx)]) {
    console.debug(match, lastIndex, match.index, s.slice(lastIndex, match.index), s.slice(match.index, match.index + 1));
    accum += s.slice(lastIndex, match.index) + '\\' + s.slice(match.index, match.index);
    lastIndex = match.index;
  }

  if (!lastIndex) {
    accum = s;
  } else {
    accum += s.slice(lastIndex, s.length);
  }

  if (s !== accum) {
    console.debug(`simpleEscapeForDiscord "${s}" -> "${accum}"`);
  }

  return accum;
}

module.exports = {
  convertDiscordChannelsToIRCInString,
  simpleEscapeForDiscord
};
