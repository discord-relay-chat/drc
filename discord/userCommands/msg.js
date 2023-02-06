
const { PREFIX, matchNetwork, resolveNameForIRCSyncFromCache, ChannelXforms } = require('../../util');
const { MessageMentions: { CHANNELS_PATTERN } } = require('discord.js');

// here we actually _want_ the unparsed `a` instead of argObj! so both are needed
async function f (context, ...a) {
  if (a.length < 2) {
    throw new Error('not enough args');
  }

  const { network } = matchNetwork(a[0]);
  const resolverCache = await ChannelXforms.all();
  const msgContent = a.slice(2).join(' ').replace(CHANNELS_PATTERN, (matchStr, channelId) => {
    if (context.channelsById[channelId]) {
      const chanSpec = context.channelsById[channelId];
      const parentNetwork = context.channelsById[chanSpec.parent];
      console.warn(`GOT CHANNEL ${chanSpec.name} in ${parentNetwork.name} for ${channelId}`);
      return '#' + resolveNameForIRCSyncFromCache(resolverCache, parentNetwork.name, chanSpec.name);
    }

    return matchStr;
  });

  console.log(`msgTarget: ${a[1]} / msgContent: "${msgContent}"`);

  await context.redis.publish(PREFIX, JSON.stringify({
    type: 'discord:requestSay:irc',
    data: {
      network,
      target: a[1],
      message: msgContent
    }
  }));
}

f.__drcHelp = () => {
  return '!msg network targetId message...';
};

module.exports = f;
