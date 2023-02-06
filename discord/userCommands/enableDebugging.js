'use strict';

const { scopedRedisClient } = require('../../util');
const logger = require('../../logger');

function enableDebugging (context) {
  let prefix = 'En';
  if (context.argObj._[0]) {
    logger.enableLevel('debug');
    console.debug('Debug logging enabled by user!');
    scopedRedisClient((rc, pfx) => rc.publish(pfx + ':__c2::irc:debug_on', JSON.stringify({ type: 'debug_on' })));
  } else {
    logger.disableLevel('debug');
    prefix = 'Dis';
    scopedRedisClient((rc, pfx) => rc.publish(pfx + ':__c2::irc:debug_off', JSON.stringify({ type: 'debug_off' })));
  }

  return `**${prefix}abled** debug logging.`;
}

enableDebugging.__drcHelp = () => {
  return {
    title: 'Toggles debug logging',
    usage: '[0|1]',
    notes: 'Currently toggles logging for both the discord & irc daemons.'
  };
};

module.exports = enableDebugging;
