'use strict';

const path = require('path');
const config = require('../../config');
const { scopedRedisClient } = require('../../util');
const { AvatarGenerators, createAvatarName, randomStyle, excludeRandomStyles } = require('../avatarGenerators');
const { getNetworkAndChanNameFromUCContext } = require('../common');
const { MessageEmbed, MessageAttachment } = require('discord.js');

async function getNickRandomStyle (context) {
  const [nick] = context.options._.slice(-1);
  const { network } = getNetworkAndChanNameFromUCContext(context);

  if (!nick || !network) {
    return `Unable to determine user identifier from "${nick}" & "${network}".`;
  }

  const avatarName = createAvatarName(nick, network);
  const style = await scopedRedisClient((c, p) => c.hget(`${p}:randomAvatarStyles`, avatarName));

  if (!AvatarGenerators[style]) {
    throw new Error(`Invalid style "${style}" for ${avatarName}!`);
  }

  return {
    style,
    avatarName,
    nick,
    network,
    avatarURL: await AvatarGenerators[style](avatarName)
  };
}

async function exampleOfStyle (style, exFName) {
  if (!style || !AvatarGenerators[style]) {
    return `Invalid style "${style}". Available styles: ${Object.keys(AvatarGenerators).join(', ')}`;
  }

  if (style === 'random_style') {
    style = await randomStyle();
  }

  if (!exFName) {
    exFName = `DiscordRelayChat_${style}`;
  }

  return {
    name: exFName,
    avatarURL: await AvatarGenerators[style](exFName),
    realStyle: style
  };
}

function parseAvatarUrlForAttachmentName (avatarURL) {
  const parsedUrl = new URL(avatarURL);
  const urlPath = path.parse(parsedUrl.pathname);
  const attName = `${urlPath.name}` +
    `${urlPath.ext?.length ? urlPath.ext : ''}` +
    (parsedUrl.search?.length ? parsedUrl.search : '');
  return attName;
}

const Commands = {
  async listAllStyles () {
    const excluded = JSON.parse(await scopedRedisClient((c, p) => c.get(p + ':randomAvatarStyles:excludeRandomStyles')));
    return Object.keys(AvatarGenerators).map(style => !excluded.includes(style) ? `**${style}**` : style).join('\n');
  },

  async resetRandomStyles () {
    return scopedRedisClient((c, p) => c.del(`${p}:randomAvatarStyles`));
  },

  getNickRandomStyle: async (context) => {
    const { style, nick, network, avatarURL } = await getNickRandomStyle(context);
    const attName = parseAvatarUrlForAttachmentName(avatarURL);
    const embed = new MessageEmbed()
      .setColor('GREYPLE')
      .setTitle(`Random avatar style: "**${style}**"`)
      .setDescription(`For **${nick}** on \`${network}\``)
      .setImage(`attachment://${attName}`)
      .addField('URL', avatarURL);
    await context.sendToBotChan({
      embeds: [embed],
      files: [new MessageAttachment(avatarURL)]
    }, true);
  },

  async getNickURL (context) {
    let style = config.app.avatarGenerator;
    let avatarName;

    if (style === 'random_style') {
      const rand = await getNickRandomStyle(context);
      style = rand.style;
      avatarName = rand.avatarName;
    } else {
      const [nick] = context.options._.slice(-1);
      const { network } = getNetworkAndChanNameFromUCContext(context);

      if (!nick || !network) {
        return `Unable to determine user identifier from "${nick}" & "${network}".`;
      }

      avatarName = createAvatarName(nick, network);
    }

    if (!style || !avatarName) {
      return `"${avatarName}" has no style or an unknown style ("${style}")!`;
    }

    return AvatarGenerators[style](avatarName);
  },

  async setNickRandomStyle (context) {
    const [style, nick] = context.options._.slice(-2);

    if (!AvatarGenerators[style]) {
      return `Invalid style "${style}".`;
    }

    if (style === 'random_style') {
      return 'Can\'t set a user\'s random style again to random!';
    }

    const { network } = getNetworkAndChanNameFromUCContext(context);

    if (!nick || !network) {
      return `Unable to determine user identifier from "${nick}" & "${network}".`;
    }

    const avatarName = createAvatarName(nick, network);
    await scopedRedisClient((c, p) => c.hset(`${p}:randomAvatarStyles`, avatarName, style));

    const embed = new MessageEmbed()
      .setColor('GREYPLE')
      .setTitle(`Set **${nick}**'s "random" avatar style to "**${style}**"`)
      .setDescription('All _new_ incoming messages will use this style.');

    let files = [];
    const avatarURL = await AvatarGenerators[style](avatarName);
    const attName = parseAvatarUrlForAttachmentName(avatarURL);
    embed.setImage(`attachment://${attName}`);
    embed.addField('URL', avatarURL);
    files = [new MessageAttachment(avatarURL)];

    await context.sendToBotChan({
      embeds: [embed],
      files
    }, true);
  },

  async setStyle (context) {
    const [, style] = context.options._;

    if (!style || !AvatarGenerators[style]) {
      return `Invalid style "${style}". Available styles: ${Object.keys(AvatarGenerators).join(', ')}`;
    }

    config.app.avatarGenerator = style;
    const embed = new MessageEmbed()
      .setColor('GREYPLE')
      .setTitle(`Set avatar style to "**${style}**"`)
      .setDescription('All _new_ incoming messages will use this style.');

    let files = [];
    if (style !== 'random_style') {
      const { avatarURL } = await exampleOfStyle(style);
      const attName = parseAvatarUrlForAttachmentName(avatarURL);
      embed.setImage(`attachment://${attName}`);
      files = [new MessageAttachment(avatarURL)];
    }

    await context.sendToBotChan({
      embeds: [embed],
      files
    }, true);
  },

  exampleOfStyle: async (context) => {
    const [, style] = context.options._;
    const { avatarURL, realStyle } = await exampleOfStyle(style);
    const attName = parseAvatarUrlForAttachmentName(avatarURL);
    const embed = new MessageEmbed()
      .setColor('GREYPLE')
      .setTitle(`Example of avatar style "${realStyle}"`)
      .setImage(`attachment://${attName}`)
      .addField('URL', avatarURL);
    await context.sendToBotChan({
      embeds: [embed],
      files: [new MessageAttachment(avatarURL)]
    }, true);
  },

  excludeRandomStyles: async (context) => {
    if (context.options.getCurrentList) {
      return JSON.parse(await scopedRedisClient((c, p) => c.get(p + ':randomAvatarStyles:excludeRandomStyles'))).join(' ');
    }

    return excludeRandomStyles(...context.options._.slice(1));
  }
};

async function avatars (context) {
  const [command] = context.options._;
  if (!Commands[command]) {
    return `Unknown subcommand "${command}". Available: ${Object.keys(Commands).join(', ')}.`;
  }

  return Commands[command](context);
}

avatars.__drcHelp = () => `Available subcommands: ${Object.keys(Commands).join(', ')}.`;

module.exports = avatars;
