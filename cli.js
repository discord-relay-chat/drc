'use strict';

const config = require('config');
const Redis = require('ioredis');
const { PREFIX } = require('./util');
const { screen, mainTitle, createMainBoxWithLabel, mainBox, inputBox, netList, chanList } = require('./cli/elements');

const redisClient = new Redis(config.redis.url);
const publishClient = new Redis(config.redis.url);
const track = {};
let curFgBox = mainBox;

function tsFmted () {
  return `{blue-fg}{bold}[${new Date().toLocaleTimeString()}]{/}`;
}

function _message (fStr) {
  mainBox.insertBottom(`${tsFmted()} ${fStr}`);
  mainBox.scrollTo(100);
  screen.render();
}

const debugMessage = (msgStr) => _message(`{cyan-fg}${msgStr}{/}`);
const systemMessage = (msgStr) => _message(`{yellow-fg}${msgStr}{/}`);
const errorMessage = (msgStr) => _message(`{red-fg}{bold}${msgStr}{/}`);

function toggleInputBox () {
  if (inputBox.__drcHidden) {
    inputBox.clearValue();
    inputBox.show();
    inputBox.focus();
    inputBox.setFront();
    curFgBox.height = '95%';
    curFgBox.scrollTo(100);
  } else {
    inputBox.hide();
    inputBox.setBack();
    mainBox.focus();
    curFgBox.height = '100%';
    curFgBox.scrollTo(100);
  }

  inputBox.__drcHidden = !inputBox.__drcHidden;
  screen.render();
}

function fgWinIsChannel () {
  const selChan = chanList.value?.split(/\s+/g)[0];

  if (curFgBox !== mainBox && (selChan === '' || selChan === curFgBox.__drcChanName)) {
    return [curFgBox.__drcNetwork, curFgBox.__drcChanName];
  }

  return [];
}

function chanListUpdate (networkName) {
  const net = track[networkName];
  const prevSel = chanList.value?.split(/\s+/g)[0];

  if (net) {
    const keysSorted = Object.keys(net).sort((a, b) =>
      a.replaceAll('#', '').localeCompare(b.replaceAll('#', '')));
    chanList.clearItems();
    chanList.setItems(keysSorted.map((k) =>
      `${k}${net[k].unread ? ` (${net[k].unread})` : ''}`));

    if (prevSel) {
      chanList.select(keysSorted.indexOf(prevSel));
    }

    screen.render();
  }
}

function chanSelect (network, chanName) {
  let chan = track[network]?.[chanName];

  if (!chan && Object.values(track[network]).length) {
    chan = Object.values(track[network])[0];
  }

  if (chan) {
    chan.box.setFront();
    chan.box.show();
    chan.box.focus();
    chan.unread = 0;
    curFgBox = chan.box;
    chanListUpdate(netList.value); // calls screen.render()
  } else {
    errorMessage(`BAD CHAN SELECT ${chanName} / ${network}`);
  }
}

inputBox.on('submit', (input) => {
  toggleInputBox();

  if (!input.length || input.match(/^\s*$/g)) {
    return;
  }

  if (input.charAt(0) === '/') {
    systemMessage('COMMAND! ' + input);
    return;
  }

  const [network, channel] = fgWinIsChannel();
  if (network && channel) {
    publishClient.publish(PREFIX, JSON.stringify({
      type: 'irc:say',
      data: {
        network: {
          name: network
        },
        channel: channel.replace(/^#/, ''),
        message: input
      }
    }));
  }
});

netList.on('select', (box) => chanListUpdate(box.parent.value));

chanList.on('select', (box) => {
  debugMessage('SLECT ' + box.parent.value);
  chanSelect(netList.value, box.parent.value.split(/\s+/g)[0]);
});

screen.key(['escape', 'q', 'C-c'], () => process.exit(0));

screen.key(['C-`', 'enter'], toggleInputBox);

screen.key(['C-up'], () => chanList.up(1));
screen.key(['C-down'], () => chanList.down(1));
screen.key(['C-l'], () => chanList.pick(() => debugMessage('picked!')));

screen.key(['C-s'], () => {
  if (curFgBox !== mainBox) {
    curFgBox.setBack();
    curFgBox = mainBox;
    curFgBox.hide();
    mainBox.focus();
    mainBox.show();
    mainBox.setFront();
    screen.render();
  } else {
    chanSelect(netList.value, chanList.value.split(/\s+/g)[0]);
  }
});

redisClient.on('pmessage', (_pattern, _channel, dataJson) => {
  try {
    const { type, data } = JSON.parse(dataJson);

    let nc = track[data?.__drcNetwork];
    if (!nc && data?.__drcNetwork) {
      nc = track[data.__drcNetwork] = {};
      debugMessage(`New network: {bold}${data.__drcNetwork}{/bold}`);

      // this is the first network! select it straightaway
      if (Object.keys(track).length === 1) {
        chanListUpdate(data.__drcNetwork);
      }
    }

    netList.setItems(Object.keys(track));

    if (nc && data.target) {
      let chan = nc[data.target];
      if (!chan) {
        chan = nc[data.target] = {
          total: 0,
          unread: 0,
          box: createMainBoxWithLabel(`${mainTitle}{bold}${data.target}{/bold} on ${data.__drcNetwork} `)
        };

        debugMessage(`New channel on ${data.__drcNetwork}: {bold}${data.target}{/bold}`);
        screen.append(chan.box);
        chan.box.hide();
        chan.box.setBack();
        chan.box.__drcNetwork = data.__drcNetwork;
        chan.box.__drcChanName = data.target;
      }

      chan.total++;

      // don't incr unread if we're looking at this channel!
      if (curFgBox.__drcChanName !== data.target) {
        chan.unread++;
      }

      // make sure to update the channel list if this is the selected network
      if (netList.value === data.__drcNetwork) {
        chanListUpdate(data.__drcNetwork);
      }

      if (type === 'irc:message') {
        const ourName = config.irc.registered[data.__drcNetwork]?.user.nick;
        data.message = data.message.replaceAll(ourName, `{#55ff33-fg}${ourName}{/}`);
        if (data.nick === ourName) {
          data.nick = data.nick.replaceAll(ourName, `{#55ff33-fg}${ourName}{/}`);
        }
        chan.box.insertBottom(`${tsFmted()} <{cyan-fg}{bold}${data.nick}{/}> {bold}${data.message}{/}`);
        chan.box.scrollTo(100);
        screen.render();
      } else {
        systemMessage(`(${_channel}) Unhandled message of type "${type}" in channel ${data.target} on ${data.__drcNetwork}: ${JSON.stringify(data)}`);
      }
    } else {
      const ignoreTypes = ['irc:join', 'irc:nick', 'irc:quit', 'irc:mode', 'irc:part'];
      if (!ignoreTypes.includes(type)) {
        systemMessage(`(${_channel}) Unhandled message of type "${type}" on ${data?.__drcNetwork}: ${dataJson}`);
      }
    }
  } catch (e) {
    errorMessage(e.message + '\n' + e.stack);
  }
});

inputBox.__drcHidden = true;
inputBox.hide();
mainBox.focus();
screen.render();

redisClient.psubscribe(PREFIX + '*');
