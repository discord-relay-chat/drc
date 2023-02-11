'use strict';

const { xxd } = require('./xxd');

// ref: https://modern.ircdocs.horse/formatting.html#characters
const ircEscapeXforms = Object.freeze({
  '\x02': '**',
  '\x1d': '_',
  '\x1f': '__',
  '\x1e': '~',
  '\x11': '`'
});

const IRCColorsStripMax = 16;

// the following aren't supported by us, so we just strip them
const ircEscapeStripSet = Object.freeze([
  ...Buffer.from(Array.from({ length: IRCColorsStripMax }).map((_, i) => i)).toString().split('').map(x => `\x03${x}`), // colors
  ...Array.from({ length: 10 }).map((_, i) => i).map(x => `\x030${x}`),
  ...Array.from({ length: 7 }).map((_, i) => i).map(x => `\x03${x + 10}`),
  '\x16', // reverse color
  '\x0f' // reset; TODO, some bots have been seen to use this byte to reset standard escapes (defined in ircEscapeXforms above)... need to handle this
  /*
  2022-01-07T09:42:51.833Z <drc/0.2/discord/debug> replaceIrcEscapes S> "Title: Python Sudoku Solver - Computerphile "
  00000000: 0254 6974 6c65 0f3a 2050 7974 686f 6e20 5375 646f 6b75 2053 6f6c 7665 7220 2d20   .Title.: Python Sudoku Solver -
  00000020: 436f 6d70 7574 6572 7068 696c 6520                                                Computerphile
  2022-01-07T09:42:51.834Z <drc/0.2/discord/debug> replaceIrcEscapes E> "**Title: Python Sudoku Solver - Computerphile "
  00000000: 2a2a 5469 746c 653a 2050 7974 686f 6e20 5375 646f 6b75 2053 6f6c 7665 7220 2d20   **Title: Python Sudoku Solver -
  00000020: 436f 6d70 7574 6572 7068 696c 6520                                                Computerphile
  */
]);

const ircEscapeStripTester = new RegExp(`(${ircEscapeStripSet.join('|')})`);
const ircEscapeTester = new RegExp(`(${Object.keys(ircEscapeXforms).join('|')})`);

function replaceIrcEscapes (message, stripAll = false) {
  let hit = false;
  const orig = message;

  console.debug(`replaceIrcEscapes> ${typeof message} message=${message}`);
  if (message.match(ircEscapeStripTester)) {
    hit = true;
    message = ircEscapeStripSet.reduce((m, esc) => m.replaceAll(esc, ''), message);
    // *after* stripping multi-byte combinations, strip any remaining color start codes (0x03)
    message = message.replaceAll(/\x03/g, ''); // eslint-disable-line no-control-regex
  }

  if (message.match(ircEscapeTester)) {
    let xForms = ircEscapeXforms;
    hit = true;

    if (stripAll) {
      xForms = Object.entries(ircEscapeXforms).reduce((a, [k]) => ({ [k]: '', ...a }), {});
    }

    message = Object.entries(xForms).reduce((m, [esc, repl]) => m.replaceAll(esc, repl), message);
  }

  if (hit) {
    console.debug(`replaceIrcEscapes S> "${orig}"\n` + xxd(orig));
    console.debug(`replaceIrcEscapes E> "${message}"\n` + xxd(message));
  }

  return message;
}

module.exports = {
  IRCColorsStripMax,
  ircEscapeStripSet,

  replaceIrcEscapes
};
