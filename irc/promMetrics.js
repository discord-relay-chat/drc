'use strict';

const { Counter } = require('../lib/promRedisExport')('irc');

const msgRxCounter = new Counter({
  name: 'drc_irc_message_received',
  help: 'Any type of IRC message received',
  labelNames: ['host']
});

const msgRxCounterWithType = new Counter({
  name: 'drc_irc_message_received_with_type',
  help: 'Any type of IRC message received, with type label',
  labelNames: ['host', 'type']
});

const eventsCounterWithType = new Counter({
  name: 'drc_irc_events_count',
  help: 'IRC events',
  labelNames: ['host', 'event']
});

const msgRxCounterByTarget = new Counter({
  name: 'drc_irc_message_received_by_target',
  help: 'Any type of IRC message received, labeled by target (usually a channel or nick)',
  labelNames: ['host', 'target']
});

module.exports = {
  msgRxCounter,
  msgRxCounterWithType,
  eventsCounterWithType,
  msgRxCounterByTarget
};
