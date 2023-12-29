const extractUrls = require('extract-urls');
const config = require('config');

function wrapUrls (text, wrapPrefix = '<', wrapPostfix = '>', checkIfEnabled = true) {
  if (typeof (text) !== 'string') {
    return text;
  }

  if (checkIfEnabled && !config.discord.disableUrlEmbeds) {
    return text;
  }

  return extractUrls(text)?.reduce((ostr, url) => ostr.replace(url, `${wrapPrefix}${url}${wrapPostfix}`), text) ?? text;
}

module.exports = {
  wrapUrls
};
