'use strict';

const config = require('config');
const Redis = require('ioredis');
const { PREFIX } = require('../util');
const initScreenElements = require('./elements');
const logger = require('../logger')('cli', false, true);

module.exports = async function () {
  const {
    screen,
    mainTitle,
    createMainBoxWithLabel,
    mainBox,
    inputBox,
    netList,
    chanList,
    helpBox
  } = initScreenElements();

  const redisClient = new Redis(config.redis.url);
  const publishClient = new Redis(config.redis.url);
  const track = {};
  let curFgBox = mainBox;

  function tsFmted () {
    return `{grey-fg}{bold}[${new Date().toLocaleTimeString()}]{/}`;
  }

  function _message (fStr, level = 'log') {
    mainBox.insertTop(`${tsFmted()} ${fStr}`);
    try {
      screen.render();
    } catch (e) {
      logger.error('_message render threw!', e);
    }

    logger[level]('(_message) ' + fStr);
  }

  const debugMessage = (msgStr) => _message(`{cyan-fg}${msgStr}{/}`, 'debug');
  const systemMessage = (msgStr) => _message(`{yellow-fg}${msgStr}{/}`);
  const errorMessage = (msgStr) => _message(`{red-fg}{bold}${msgStr}{/}`, 'error');

  function curFgInsert (fStr, { ts, log } = { ts: true }) {
    const insStr = (ts ? `${tsFmted()} ` : '') + fStr;
    curFgBox.insertTop(insStr);
    screen.render();
    if (log) {
      if (!logger[log]) {
        errorMessage(`_curFgInsert: Bad log level "${log}"`);
      } else {
        logger[log](insStr);
      }
    }
  }

  function toggleOverlayElement (element) {
    if (element.__drcHidden) {
      if (element.constructor.name === 'Textbox') {
        element.clearValue();
      }
      element.show();
      element.focus();
      element.setFront();
    } else {
      element.hide();
      element.setBack();
      mainBox.focus();
    }

    element.__drcHidden = !element.__drcHidden;
    screen.render();
  }

  function toggleInputBox () {
    toggleOverlayElement(inputBox);
  }

  function toggleHelpBox () {
    toggleOverlayElement(helpBox);
  }

  function fgWinIsChannel () {
    const selChan = chanList.value?.split(/\s+/g)[0];

    logger.debug(`fgWinIsChannel: selChan=${selChan} curFgBox=${curFgBox.__drcChanName} eq?=${curFgBox === mainBox}`);
    if (curFgBox !== mainBox && (selChan === '' || selChan === curFgBox.__drcChanName)) {
      return [curFgBox.__drcNetwork, curFgBox.__drcChanName];
    }

    return [];
  }

  function chanSorter (a, b) {
    return a.replaceAll('#', '').localeCompare(b.replaceAll('#', ''));
  }

  function chanListUpdate (networkName) {
    const net = track[networkName];
    const prevSel = curFgBox !== mainBox && curFgBox.__drcNetwork === networkName ? curFgBox.__drcChanName : undefined;

    if (net) {
      const keysSorted = Object.keys(net).sort(chanSorter);
      chanList.clearItems();
      chanList.setItems(keysSorted.map((k) =>
        `${k}${net[k].unread ? ` (${net[k].has_mention ? '*' : ''}${net[k].unread})` : ''}`));

      if (prevSel) {
        chanList.select(keysSorted.indexOf(prevSel));
      }

      chanList.render();
    } else {
      logger.error(`chanListUpdate: bad network!? "${networkName}"`);
    }
  }

  let chanCurIndex;
  function chanSelect (network, chanNameOrIndex) {
    if (!track[network]) {
      throw new Error(`chanSelect: bad network "${network}"!`);
    }

    const net = track[network];
    const sortedChans = Object.keys(net).sort(chanSorter);
    let chan;
    if (typeof chanNameOrIndex === 'number') {
      if (chanNameOrIndex >= sortedChans.length) {
        return;
      }

      chan = net[sortedChans[chanNameOrIndex]];
      chanNameOrIndex = sortedChans[chanNameOrIndex];
    } else {
      chan = net[chanNameOrIndex];
    }

    if (!chan && Object.values(net).length) {
      chan = Object.values(net)[0];
    }

    if (chan && chan.box) {
      chan.box.setFront();
      chan.box.show();
      chan.box.focus();
      chan.unread = 0;
      chan.has_mention = false;
      curFgBox = chan.box;
      chanListUpdate(netList.value);
      screen.render();
      chanCurIndex = sortedChans.indexOf(chanNameOrIndex);
      logger.debug(`chanSelect: selected ${network} ${chanNameOrIndex}`);
    } else {
      errorMessage(`BAD CHAN SELECT ${chanNameOrIndex} / ${network}`);
      logger.debug(chan);
    }
  }

  const msgTrack = {
    totalInserted: {
      count: 0,
      bytes: 0
    }
  };

  let commandsCache; // eslint-disable-line
  const commands = {
    mem: {
      exec: (...a) => {
        const _f = (b) => `${Number(b / 1024 / 1024).toFixed(1)}MB`;
        const { last } = commandsCache.mem;
        const cur = process.memoryUsage();
        const rStr = `RSS: ${_f(cur.rss)} ` +
          (last ? `(${_f(cur.rss - last.rss)} delta) ` : '') +
          Object.keys(cur)
            .filter((k) => k !== 'rss')
            .map((k) => `${k}=${_f(cur[k])}`)
            .join(' ');
        commandsCache.mem.last = cur;
        return rStr;
      },
      help: 'Show process memory usage'
    },
    msgs: {
      exec: (...a) => {
        return `${msgTrack.totalInserted.bytes} bytes over ${msgTrack.totalInserted.count} messages`;
      },
      help: 'Show count & byte size of recieved messages'
    }
  };

  commands.mm = {
    exec: (...a) => commands.mem.exec(a) + ' -- ' + commands.msgs.exec(a),
    help: 'Combines /mem & /msgs'
  };

  commandsCache = Object.keys(commands).reduce((a, k) => ({ [k]: {}, ...a }), {});

  inputBox.on('submit', (input) => {
    toggleInputBox();

    if (!input.length || input.match(/^\s*$/g)) {
      return;
    }

    if (input.charAt(0) === '/') {
      let [cmd, ...args] = input.split(/\s+/g);
      cmd = cmd.replace(/^\//, '');

      if (commands[cmd]) {
        curFgInsert('{yellow-fg}' + commands[cmd].exec(args) + '{/}', { ts: true, log: 'log' });
      }

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

  netList.on('select', (box) => {
    logger.log(`netList#select [${box.parent.value}]`);
    chanListUpdate(box.parent.value);
  });

  chanList.on('select', (box) => {
    logger.log(`chanList#select [${netList.value}] [${box.parent.value}]`);
    chanSelect(netList.value, box.parent.value.split(/\s+/g)[0]);
  });

  screen.key(['escape', 'q', 'C-c'], () => process.exit(0));

  screen.key(['enter'], toggleInputBox);
  screen.key(['?'], toggleHelpBox);

  screen.key(['C-d'], () => {
    logger.debug('---debug dump---');
    logger.debug(curFgBox.__drcChanName, curFgBox.getScroll(), curFgBox.getScrollHeight(), curFgBox.getScrollPerc());
    logger.debug('---/debug dump---');
  });

  screen.key(['C-up'], () => curFgBox.scroll(-1));
  screen.key(['C-down'], () => curFgBox.scroll(1));
  screen.key(['C-S-up'], () => curFgBox.scroll(-10));
  screen.key(['C-S-down'], () => curFgBox.scroll(10));
  screen.key(['C-space', 'C-spacebar'], () => curFgBox.resetScroll());

  // M-x switches to channel index x (special case M-0 -> channel 10); Fx switches to channel index x+10
  screen.key(['M-0'], () => chanSelect(netList.value, 9));
  Array.from({ length: 9 }, (_, i) => {
    screen.key([`M-${i + 1}`], () => chanSelect(netList.value, i));
    screen.key([`f${i + 1}`], () => chanSelect(netList.value, i + 10));
    return i;
  });

  const chanUpDown = (dir) => {
    if (chanCurIndex !== undefined && chanCurIndex + dir >= 0) {
      logger.debug(`chanUpDown ${chanCurIndex} -> ${chanCurIndex + dir}`);
      chanSelect(netList.value, chanCurIndex + dir);
    }
  };

  screen.key(['M-up'], chanUpDown.bind(null, -1));
  screen.key(['M-down'], chanUpDown.bind(null, 1));

  screen.on('resize', () => {
    logger.log('screen#resize ', screen.width, screen.height);
  });

  let lastChanBox;
  screen.key(['C-s'], () => {
    if (curFgBox !== mainBox) {
      curFgBox.setBack();
      lastChanBox = curFgBox;
      curFgBox = mainBox;
      curFgBox.hide();
      mainBox.focus();
      mainBox.show();
      mainBox.setFront();
      screen.render();
    } else {
      if (lastChanBox) {
        chanSelect(netList.value, lastChanBox.__drcChanName);
        lastChanBox = null;
      }
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
      netList.render();

      if (nc && data.target) {
        let chan = nc[data.target];
        if (!chan) {
          chan = nc[data.target] = {
            total: 0,
            unread: 0,
            has_mention: false,
            box: createMainBoxWithLabel(`${mainTitle}{bold}${data.target}{/bold} on ${data.__drcNetwork} `)
          };

          debugMessage(`New channel on ${data.__drcNetwork}: {bold}${data.target}{/bold}`);
          screen.append(chan.box);
          chan.box.hide();
          chan.box.setBack();
          chan.box.__drcNetwork = data.__drcNetwork;
          chan.box.__drcChanName = data.target;
          chan.box.__drcNickColors = {
            next: 0,
            nicks: {}
          };
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
          const pLen = data.message.length;
          data.message = data.message.replaceAll(ourName, `{#55ff33-fg}${ourName}{/}`);
          chan.has_mention = pLen !== data.message.length && curFgBox.__drcChanName !== data.target;

          if (data.nick === ourName) {
            data.nick = data.nick.replaceAll(ourName, `{#55ff33-fg}${ourName}{/}`);
          }

          let nickColor = chan.box.__drcNickColors.nicks[data.nick];

          if (!nickColor) {
            nickColor = chan.box.__drcNickColors.nicks[data.nick] = config.cli.nickColors[chan.box.__drcNickColors.next++];

            if (chan.box.__drcNickColors.next >= config.cli.nickColors.length) {
              chan.box.__drcNickColors.next = 0;
            }

            logger.debug(`Assigned new nick color ${nickColor} to ${data.nick} in ${data.target}/${data.__drcNetwork} (next=${chan.box.__drcNickColors.next})`);
          }

          const insStr = `${tsFmted()} <{${nickColor}-fg}{bold}${data.nick}{/}> ${data.message}`;
          chan.box.insertTop(insStr);
          screen.render();
          setImmediate(() => {
            msgTrack.totalInserted.count++;
            msgTrack.totalInserted.bytes += Buffer.byteLength(insStr, 'utf8');
          });
        } else {
          // systemMessage(`(${_channel}) Unhandled message of type "${type}" in channel ${data.target} on ${data.__drcNetwork}: ${JSON.stringify(data)}`);
        }
      } else {
        const ignoreTypes = ['irc:join', 'irc:nick', 'irc:quit', 'irc:mode', 'irc:part'];
        if (!ignoreTypes.includes(type)) {
          // systemMessage(`(${_channel}) Unhandled message of type "${type}" on ${data?.__drcNetwork}: ${dataJson}`);
        }
      }
    } catch (e) {
      errorMessage(e.message + '\n' + e.stack);
    }
  });

  const longestCommand = Object.keys(commands).reduce((a, x) => Math.max(a, x.length), 0) + 1;
  helpBox.setContent(helpBox.getContent() + [
    '',
    '',
    '{bold}Commands:{/}',
    '',
    ...Object.entries(commands).map(([cmdName, cmdObj]) =>
      `{cyan-fg}/${cmdName.padEnd(longestCommand, ' ')}{/}\t${cmdObj.help}`)
  ].join('\n\t')
  );

  mainBox.focus();
  screen.render();

  redisClient.psubscribe(PREFIX + '*');
};
