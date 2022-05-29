const fs = require('fs');
const path = require('path');
const util = require('util');
const config = require('config');
const { NAME, VERSION } = require('./util');

const LEVELS = ['log', 'info', 'warn', 'error', 'debug'];

const enabledLevels = new Set(LEVELS);

function enableLevel (l) {
  enabledLevels.add(l);
}

function disableLevel (l) {
  enabledLevels.delete(l);
}

let logger;

function initialize (processName = process.title, overrideConsole = true, onlyToFile = false) {
  if (!logger) {
    if (!fs.existsSync(config.app.log.path)) {
      fs.mkdirSync(config.app.log.path);
    }

    const APP_NAMEVER = [NAME, VERSION, processName, process.pid].join('/');
    const dsMapper = (dsArr, colors = false) => dsArr.map(x => typeof x === 'string' ? x : util.inspect(x, { colors, depth: null })).join(' ');

    const _outStream = fs.createWriteStream(path.join(config.app.log.path, `${processName}.log`));
    const _console = LEVELS.reduce((a, x) => ({ [x]: console[x], ...a }), {});

    const _emit = (level, ...a) => {
      if (!enabledLevels.has(level)) {
        return;
      }

      const dstrArr = [new Date(), `<${APP_NAMEVER}/${level}>`, ...a];
      _outStream.write(dsMapper([{ level }, ...dstrArr, '\n']));
      if (!onlyToFile) {
        _console[level](dsMapper(dstrArr, true));
      }
    };

    logger = LEVELS.reduce((a, lvl) => ({ [lvl]: _emit.bind(logger, lvl), ...a }), { APP_NAMEVER });

    if (overrideConsole) {
      LEVELS.forEach(level => (console[level] = logger[level]));
    }

    if (!process.env.DEBUG) {
      disableLevel('debug');
    }
  }

  return logger;
}

initialize.enableLevel = enableLevel;
initialize.disableLevel = disableLevel;

module.exports = initialize;
