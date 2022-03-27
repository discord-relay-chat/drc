'use strict';

const blessed = require('blessed');
const { VERSION } = require('../util');

module.exports = function () {
  const screen = blessed.screen({ smartCSR: true });
  const mainTitle = ' [{#11eebb-fg}Discord Relay Chat v' + VERSION + '{/}] ';
  screen.title = 'Discord Relay Chat v' + VERSION;

  const mainBoxTmpl = {
    top: '0',
    left: '0',
    width: '85%',
    height: '100%',
    content: null,
    tags: true,
    border: {
      type: 'line'
    },
    style: {
      fg: 'white',
      bg: 'black',
      border: {
        fg: 'cyan'
      },
      scrollbar: {
        bg: 'red',
        fg: 'blue'
      }
    },
    scrollable: true,
    alwaysScroll: true,
    mouse: false
  };

  function createMainBoxWithLabel (label) {
    return blessed.box(Object.assign({ label }, mainBoxTmpl));
  }

  const mainBox = createMainBoxWithLabel(mainTitle);

  const inputBox = blessed.textbox({
    bottom: '0',
    left: '1',
    width: '85%',
    height: '70',
    border: {
      type: 'line'
    },
    style: {
      fg: 'white',
      bg: 'black',
      border: {
        fg: 'green'
      }
    },
    keys: true,
    inputOnFocus: true
  });

  const netList = blessed.list({
    right: '0',
    top: '0',
    width: '15%',
    height: '20%',
    border: {
      type: 'line'
    },
    label: 'Networks',
    mouse: true,
    style: {
      selected: {
        fg: 'cyan'
      }
    }
  });

  const chanList = blessed.list({
    right: '0',
    top: '20%',
    width: '15%',
    height: '80%',
    border: {
      type: 'line'
    },
    label: 'Channels',
    mouse: true,
    style: {
      selected: {
        fg: 'cyan'
      }
    }
  });

  const keybindHelp = {
    'Esc, q, C-c': 'Quit',
    Enter: 'Show/hide the input box',
    '?': 'Show/hide this help box',
    'C-s': 'Show/hide the application logging window',
    'C-up': 'Scroll the current window up by one line',
    'C-down': 'Scroll the current window down by one line',
    'C-S-up': 'Scroll the current window up by 10 lines',
    'C-S-down': 'Scroll the current window down by 10 lines',
    'C-spacebar': 'Reset current window scroll to the top',
    'M-1 through M-0': 'Switch to channels 1 through 10',
    'F1 through F12': 'Switch to channels 11 through 22',
    'M-up': 'Switch to the channel above the current',
    'M-down': 'Switch to the channel below the current'
  };
  const keybindLongestKey = Object.keys(keybindHelp).reduce((a, x) => Math.max(a, x.length), 0);

  const helpBox = blessed.box({
    top: 'center',
    left: 'center',
    width: '380',
    height: '640',
    border: {
      type: 'line'
    },
    label: 'Help',
    tags: true,
    content: [
      '',
      '{bold}Keybindings:{/}',
      '',
      ...Object.entries(keybindHelp)
        .map(([k, v]) =>
          `{cyan-fg}${k.padEnd(keybindLongestKey, ' ')}{/}\t${v}`)
    ].join('\n\t')
  });

  screen.append(mainBox);
  screen.append(netList);
  screen.append(chanList);
  screen.append(inputBox);
  screen.append(helpBox);
  inputBox.hide();
  inputBox.__drcHidden = true;
  helpBox.hide();
  helpBox.__drcHidden = true;

  return {
    screen,
    mainTitle,
    createMainBoxWithLabel,
    mainBox,
    inputBox,
    netList,
    chanList,
    helpBox
  };
};
