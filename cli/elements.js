'use strict';

const blessed = require('blessed');
const { VERSION } = require('../util');

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
      fg: '#f0f0f0'
    },
    scrollbar: {
      bg: 'red',
      fg: 'blue'
    }
  },
  scrollable: true,
  alwaysScroll: true
};

function createMainBoxWithLabel (label) {
  return blessed.box(Object.assign({ label }, mainBoxTmpl));
}

const mainBox = createMainBoxWithLabel(mainTitle);

const inputBox = blessed.textbox({
  bottom: '0',
  left: '1',
  width: '85%',
  height: '8%',
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

screen.append(mainBox);
screen.append(netList);
screen.append(chanList);
screen.append(inputBox);

module.exports = {
  screen,
  mainTitle,
  createMainBoxWithLabel,
  mainBox,
  inputBox,
  netList,
  chanList
};
