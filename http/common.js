'use strict';

const fs = require('fs');
const path = require('path');
const mustache = require('mustache');
const { NAME, VERSION } = require('../util');

require('../logger')('http-common');

let templates = null;
function templatesLoad (force = false) {
  if (!force && templates) {
    return;
  }

  const templatePath = path.join(__dirname, 'templates');
  templates = Object.freeze(fs.readdirSync(templatePath).reduce((a, tmplPath) => {
    const { name } = path.parse(tmplPath);
    return {
      [name]: () => fs.readFileSync(path.join(templatePath, tmplPath)).toString('utf8'),
      ...a
    };
  }, {}));

  console.log(`Loaded templates: ${Object.keys(templates).join(', ')}`);
}

// `renderType` can be the name (no extension) of any of the defined templates
// `body` should be an object of shape: { network, elements: [] }
function renderTemplate (renderType, body, expiry) {
  templatesLoad();

  if (!templates[renderType]) {
    throw new Error(`Invalid render type "${renderType}"`);
  }

  if (body.elements) {
    // this shouldn't be here! probably...
    body.elements.forEach((ele) => {
      if (ele.timestamp) {
        ele.timestampString = new Date(ele.timestamp).toDRCString();
      }
    });
  }

  const renderObj = {
    NAME,
    VERSION,
    captureTimestamp: new Date().toDRCString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...body
  };

  if (expiry) {
    renderObj.documentExpiresAt = (new Date(expiry)).toDRCString();
  }

  return {
    body: mustache.render(templates[renderType](), renderObj),
    renderType,
    renderObj
  };
}

module.exports = {
  getTemplates () { return templates; },
  renderTemplate,
  templatesLoad
};
