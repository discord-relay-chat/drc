/* show all on system:

    require('./discord/figletBanners').fonts.forEach(f => require('./discord/figletBanners').banner(f, f).then(x => console.log(x)))
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const { execSync } = require('child_process');
const config = require('config');

let defaultFont;
let fonts;
let banner = (bannerString) => bannerString;

if (config.figletBanners && config.figletBanners.enabled) {
  if (!fs.existsSync(config.figletBanners.cacheDir)) {
    fs.mkdirSync(config.figletBanners.cacheDir);
  }

  const fontDir = execSync('figlet -I2').toString('utf8').replace(/\n/g, '');
  fonts = fs.readdirSync(fontDir)
    .map(x => path.parse(x))
    .filter(x => x.ext === '.flf')
    .map(x => x.name);

  banner = async (bannerString, font, options = {}) => {
    font = font ?? defaultFont;

    if (font && !fonts.find(x => x === font)) {
      throw new Error('bad font: ' + font);
    }

    const strHash = crypto.createHash('sha256').update(bannerString + (font ? `__font:${font}` : '')).digest('hex');
    const cachePath = path.join(config.figletBanners.cacheDir, strHash);

    if (fs.existsSync(cachePath) && !options.skipCache) {
      return (await fs.promises.readFile(cachePath)).toString('utf8');
    }

    const { stdout, stderr } = await exec('figlet -W ' + (font ? `-f ${font} ` : '') + `"${bannerString}"`);

    if (stderr.length) {
      throw new Error(stderr);
    }

    await fs.promises.writeFile(cachePath, stdout);
    return stdout.toString('utf8');
  };
}

module.exports = {
  fonts,
  banner,
  setDefaultFont: (font) => (defaultFont = font)
};
