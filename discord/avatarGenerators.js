'use strict';

const {
  scopedRedisClient
} = require('../util');

async function DiceBearGenerator (style, fName) {
  return `https://api.dicebear.com/5.x/${style}/png?seed=${fName}`;
}

const AvatarGenerators = {
  robohash: async (fName) => `https://robohash.org/${fName}.png`,
  dicebear_shapes: DiceBearGenerator.bind(null, 'shapes'),
  dicebear_pixelart: DiceBearGenerator.bind(null, 'pixel-art'),
  dicebear_identicon: DiceBearGenerator.bind(null, 'identicon'),
  dicebear_personas: DiceBearGenerator.bind(null, 'personas'),
  dicebear_micah: DiceBearGenerator.bind(null, 'micah'),
  dicebear_miniavs: DiceBearGenerator.bind(null, 'miniavs'),
  dicebear_bottts: DiceBearGenerator.bind(null, 'bottts'),
  dicebear_botttsneutral: DiceBearGenerator.bind(null, 'bottts-neutral'),
  dicebear_bigsmile: DiceBearGenerator.bind(null, 'big-smile'),
  multiavatar: async (fName) => `https://api.multiavatar.com/${fName}.png`,
  uiavatars: async (fName) => `https://ui-avatars.com/api/${fName}.png?name=${fName}&background=random&format=png`,
  uiavatars_red: async (fName) => `https://ui-avatars.com/api/${fName}.png?name=${fName}&background=ff0000&format=png`,
  uiavatars_darkred: async (fName) => `https://ui-avatars.com/api/${fName}.png?name=${fName}&background=b30d2f&format=png`,
  random_style: RandomGenerator
};

const rKey = (p) => [p, 'randomAvatarStyles'].join(':');

async function randomStyle () {
  const excluded = JSON.parse(await scopedRedisClient((c, p) => c.get(rKey(p) + ':excludeRandomStyles'))) ?? [];
  const styles = Object.keys(AvatarGenerators).filter((style) => !excluded.includes(style));
  let setStyle;
  // don't ever chose "random_style"!
  while (!setStyle || setStyle === 'random_style') {
    setStyle = styles[Math.floor(Math.random() * styles.length)];
  }
  return setStyle;
}

async function RandomGenerator (fName) {
  let setStyle = await scopedRedisClient((c, p) => c.hget(rKey(p), fName));

  if (!setStyle) {
    setStyle = await randomStyle();
    console.info(`User ${fName} did not have an avatar style: chose ${setStyle}`);
    await scopedRedisClient((c, p) => c.hset(rKey(p), fName, setStyle));
  }

  return AvatarGenerators[setStyle](fName);
}

module.exports = {
  AvatarGenerators,

  createAvatarName (nick, network) {
    return [nick, network].map((s) => s.replaceAll(/[^\d\w._-]+/g, '')).join('_');
  },

  randomStyle,

  async excludeRandomStyles (...styles) {
    return scopedRedisClient((c, p) => c.set(rKey(p) + ':excludeRandomStyles', JSON.stringify(styles)));
  }
};
