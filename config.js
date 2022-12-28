'use strict';

const baseConfig = require('config');

if (!baseConfig.app.allowedSpeakersAdd) {
  baseConfig.app.allowedSpeakersAdd = function (addUserId) {
    if (baseConfig.discord.botId === addUserId) {
      // TODO: need to remove bot from role on Discord!
      return false;
    }

    baseConfig.app.allowedSpeakers.push(addUserId);
    return true;
  };

  baseConfig.app.allowedSpeakersRemove = function (rmUserId) {
    const preLen = baseConfig.app.allowedSpeakers.length;
    baseConfig.app.allowedSpeakers = baseConfig.app.allowedSpeakers.filter(asId => asId !== rmUserId);
    return preLen > baseConfig.app.allowedSpeakers.length;
  };

  baseConfig.app.allowedSpeakersMerge = function (mergeUserIdList) {
    const preLen = baseConfig.app.allowedSpeakers.length;
    baseConfig.app.allowedSpeakers = [...new Set([
      ...baseConfig.app.allowedSpeakers,
      ...mergeUserIdList
    ])];
    return preLen !== baseConfig.app.allowedSpeakers.length;
  };
}

module.exports = baseConfig;
