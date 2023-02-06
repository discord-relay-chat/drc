'use strict';

const config = require('../config');

const SERIAL_PIPE_TOKEN = '|>';
const CONC_PIPE_TOKEN = '!>';

function checkMessageStringForPipes (messageString) {
  if (!(messageString.indexOf(SERIAL_PIPE_TOKEN) !== -1 || messageString.indexOf(CONC_PIPE_TOKEN) !== -1)) {
    return false;
  }

  return true;
}

function parseMessageStringForPipes (messageString, commandWrapperFunc = (s) => s) {
  if (!checkMessageStringForPipes(messageString)) {
    return null;
  }

  const funcsParsed = messageString
    .split(SERIAL_PIPE_TOKEN)
    .filter((s) => s.length > 0)
    .map((s) => s.trim())
    .map((s) =>
      async () => Promise.all(s.split(CONC_PIPE_TOKEN)
        .filter((si) => si.length > 0)
        .map((si) => si.trim())
        .map(commandWrapperFunc))
    );

  return async function () {
    const results = [];
    for (const serialChunk of funcsParsed) {
      results.push(await serialChunk());
    }
    return results;
  };
}

function parseArgsForQuotes (args) {
  const quotesParse = args.reduce((a, e) => {
    if ((e.indexOf('"') === 0 || e.match(/--\w+="/)) && !a.collect.length) {
      a.collect.push(e);
    } else if (a.collect.length) {
      if (e.match(/[^"]+"/)) {
        a.return.push([...a.collect, e].join(' '));
        a.collect = [];
      } else {
        a.collect.push(e);
      }
    } else {
      a.return.push(e);
    }

    return a;
  }, {
    collect: [],
    return: []
  });

  return [...quotesParse.return, ...quotesParse.collect];
}

function parseCommandAndArgs (trimContent, {
  autoPrefixCurrentCommandChar = false
} = {}) {
  if (autoPrefixCurrentCommandChar) {
    if (trimContent.indexOf(config.app.allowedSpeakersCommandPrefixCharacter) !== -1) {
      throw new Error(`Programming error: autoPrefixCurrentCommandChar == true but command string already prefixed:\n\t"${trimContent}"`);
    }

    console.info(`Auto-prefixing '${config.app.allowedSpeakersCommandPrefixCharacter}' onto "${trimContent}"`);
    trimContent = config.app.allowedSpeakersCommandPrefixCharacter + trimContent;
  }

  if (trimContent.indexOf(config.app.allowedSpeakersCommandPrefixCharacter) === -1) {
    throw new Error(`Programming error: parseCommandAndArgs called with malformed argument:\n\t"${trimContent}"`);
  }

  const [command, ...args] = trimContent.slice(
    trimContent.indexOf(config.app.allowedSpeakersCommandPrefixCharacter) + 1
  ).trim().split(/\s+/);

  return { command, args };
}

module.exports = {
  parseMessageStringForPipes,
  parseArgsForQuotes,
  parseCommandAndArgs
};
