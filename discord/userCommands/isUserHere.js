const config = require('../../config');
const { resolveNameForIRC } = require('../../util');
const { isNickInChan, simpleEscapeForDiscord } = require('../common');

module.exports = async (context, ...a) => {
  const message = context?.discordMessage;
  if (!message) {
    return 'No required message data FIXME';
  }

  const [userNick] = a;

  if (!userNick) {
    return 'No nickname given.';
  }

  if (message && userNick) {
    const chanObj = context.channelsById[message.channelId];
    const parentNetworkName = context.channelsById[chanObj?.parent]?.name ?? null;

    if (chanObj?.name && parentNetworkName && config.irc.registered[parentNetworkName]) {
      const ircChanName = '#' + resolveNameForIRC(parentNetworkName, chanObj?.name);
      const { nickInChan, newNick } = await isNickInChan(userNick, chanObj?.name, parentNetworkName, context.registerOneTimeHandler);
      console.log(userNick, 'in ', ircChanName, '/', parentNetworkName, '? -->', { nickInChan, newNick });
      const [nickEsc, newEsc] = [userNick, newNick].map(simpleEscapeForDiscord);
      let retStr = `No, **${nickEsc}** is not in \`${ircChanName}\` on \`${parentNetworkName}\``;

      if (nickInChan || newNick) {
        retStr = `Yes, **${nickEsc}** is in \`${ircChanName}\` on \`${parentNetworkName}\``;
        if (newNick) {
          retStr += `, but they've since changed their nickname to **${newEsc}**`;
        }
      }

      if (context?.isFromReaction) {
        // why is this being removed after a time too?!
        // also really just need to figure out how to send the text to the channel
        // after a reaction, because cannot inform the user about a newNick with only emojis! :facepalm:
        message?.react(nickInChan ? '👍' : '👎');
      }

      return retStr + '.';
    }
  }

  return 'Missing message data? FIXME';
};
