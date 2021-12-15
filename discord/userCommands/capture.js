const config = require('config');
const { PREFIX, matchNetwork } = require('../../util');
const { serveMessages } = require('../common');
const { MessageMentions: { CHANNELS_PATTERN } } = require('discord.js');

async function f (context, ...a) {
  if (!config.capture.enabled) {
    console.error('Not enabled');
    return;
  }

  const [netStub, channelIdSpec, cmd] = context.options._;
  console.debug('CAPTURE ARGS', netStub, channelIdSpec, cmd, context.options, a);

  if (!netStub || !channelIdSpec) {
    console.error('Not enough args');
    return;
  }

  if (cmd === undefined && channelIdSpec === 'list') {
    return context.captureSpecs;
  }

  if (!channelIdSpec.match(CHANNELS_PATTERN)) {
    console.error(`Bad channel ID spec ${channelIdSpec}`);
    return;
  }

  const [_, channelId] = [...channelIdSpec.matchAll(CHANNELS_PATTERN)][0]; // eslint-disable-line no-unused-vars
  const { network } = matchNetwork(netStub);
  context.network = network;

  if (cmd === 'query') {
    /// this is LITERALLY copy/pasted from 'mentions': REFACTOR TOGETHER!!
    const luKey = [PREFIX, 'capture', channelId, network, 'stream'].join(':');
    console.debug('CAPTURES', luKey, context.options);
    const allKeys = await context.redis.xrange(luKey, '-', '+');
    console.debug(allKeys);

    const allMsgKeys = allKeys.flatMap((idList) => idList.flatMap((ele) => ele[0] === 'message' ? ele[1] : null)).filter(x => !!x);
    console.debug(allMsgKeys);

    const allMsgs = [];
    for (const msgKey of allMsgKeys) {
      allMsgs.push(JSON.parse(await context.redis.get(luKey + msgKey)));
    }

    console.debug(allMsgs);

    if (allMsgs.length) {
      serveMessages(context, allMsgs);
    } else {
      context.sendToBotChan('No messages');
    }

    return;
  }

  let netSpec = context.captureSpecs[network];

  if (!netSpec) {
    netSpec = context.captureSpecs[network] = {};
  }

  console.debug('CAPTURE', channelId, network, context.options, ...a);

  const curSpec = netSpec[channelId];
  const durMins = context.options.num ? null : context.options.duration || config.capture.defaultCaptureWindowMins;

  if (!durMins && !context.options.num) {
    throw new Error('bad spec');
  }

  const exp = context.options.num ? context.options.num : Number(new Date()) + (durMins * 60 * 1000);

  netSpec[channelId] = {
    exp,
    captured: curSpec ? curSpec.captured : 0
  };

  context.sendToBotChan(`${curSpec ? `**(Updated at ${curSpec.captured} messages captured)** ` : ''}` +
    `${context.overridePrefixMsg ?? 'Capturing'} **${durMins || exp} ${durMins ? 'minutes' : 'messages'}** from <#${channelId}> (\`${network}\`)`);
}

f.__drcHelp = () => {
  return '!capture network channel cmd';
};

module.exports = f;
