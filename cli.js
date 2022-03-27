#!/usr/bin/env node

'use strict';

const logging = require('./logger');
const logger = logging('cli', false, true);
const { hideBin } = require('yargs/helpers');
const argv = require('yargs/yargs')(hideBin(process.argv))
  .usage('Usage: $0 [command] [options]')
  .usage('When command is not specified, runs a simple IRC frontend.')
  .usage('All options listed below apply *only* to inspector mode.')
  .command('inspector', 'Run in inspector mode')
  .alias('e', 'event')
  .nargs('e', 1)
  .describe('e', 'The event (regex) to listen to in inspector mode')
  .alias('p', 'path')
  .nargs('p', 1)
  .describe('p', 'Require property "path" is defined in event data')
  .alias('v', 'value')
  .nargs('v', 1)
  .describe('v', 'Expect property "path" to have "value" (regex)')
  .alias('o', 'optionalPath')
  .nargs('o', 1)
  .describe('o', 'Extract (if available) the optionalPath from event data; multiple -o specifications are allowed')
  .alias('q', 'quiet')
  .nargs('q', 0)
  .describe('q', 'Quiet mode, do not emit the entire event object')
  .alias('t', 'terse')
  .nargs('t', 0)
  .describe('t', 'Emit event object on one line, not pretty-printed')
  .alias('l', 'long')
  .nargs('l', 0)
  .describe('l', 'Emit extracted paths in long form')
  .alias('i', 'insensitive')
  .nargs('i', 0)
  .describe('i', 'Regexs are case-insensitive')
  .help('h')
  .alias('h', 'help')
  .argv;

if (argv.debug) {
  logging.enableLevel('debug');
  logger.debug('Debug logging enabled');
}

(async function () {
  const inspectorMode = argv._[0] === 'inspector';
  try {
    if (inspectorMode) {
      if (!argv.event) {
        throw new Error('No event given for inspector mode');
      }

      return await require('./cli/inspector')(argv);
    }

    await require('./cli/main')();
  } catch (err) {
    logger.error('cli/main threw', err);
    if (inspectorMode) {
      console.error(err);
    }
  }
})();
