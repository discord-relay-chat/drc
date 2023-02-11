'use strict';

const fs = require('fs');
const path = require('path');
const config = require('config');
const { nanoid } = require('nanoid');
const { PREFIX, scopedRedisClient, fqUrlFromPath } = require('../../util');
const { MessageEmbed } = require('discord.js');
const httpCommon = require('../../http/common');
const { isHTTPRunning } = require('../../lib/isXRunning');

const serveMessagesLocalFSOutputFormats = {
  html: (data, network) => {
    return httpCommon.renderTemplate('digest', { network, elements: data }).body;
  },

  json: (data) => JSON.stringify(data.reduce((a, {
    timestamp, data: {
      type, nick, ident, hostname, target, message, tags
    }
  }) => ([...a, {
    timestampMs: timestamp, type, nick, ident, hostname, target, message, tags
  }]), [])),

  jsonl: (data) => data.reduce((a, {
    timestamp, data: {
      type, nick, ident, hostname, target, message, tags
    }
  }) => (a += JSON.stringify({
    timestampMs: timestamp, type, nick, ident, hostname, target, message, tags
  }) + '\n'), '')
};

async function serveMessagesLocalFS (context, data, opts = {}) {
  const outpath = 'queries.out';
  const { localQueryOutputFormat } = config.app.log;
  const logPath = path.join(path.resolve(config.irc.log.path), outpath);

  if (!fs.existsSync(logPath)) {
    await fs.promises.mkdir(logPath);
  }

  const logname = `${context.network}_${new Date().toISOString()}`.replaceAll(':', '') +
    '.' + localQueryOutputFormat;
  const fname = path.join(logPath, logname);
  await fs.promises.writeFile(fname,
    serveMessagesLocalFSOutputFormats[localQueryOutputFormat](data, context.network));
  console.log('Wrote', fname);
  context.sendToBotChan(`**${data.length}** messages for \`${context.network}\` ` +
    `written to **${logname}** in the logging \`${outpath}\` subdirectory.`);
}

// this and servePage should be refactored together, they're very similar
async function serveMessages (context, data, opts = {}) {
  if (!config.http.enabled || !(await isHTTPRunning(context.registerOneTimeHandler, context.removeOneTimeHandler))) {
    return serveMessagesLocalFS(context, data, opts);
  }

  const name = nanoid();

  if (!data.length) {
    context.sendToBotChan(`No messages for \`${context.network}\` were found.`);
    return;
  }

  context.registerOneTimeHandler('http:get-req:' + name, name, async () => {
    await scopedRedisClient(async (r) => {
      await r.publish(PREFIX, JSON.stringify({
        type: 'http:get-res:' + name,
        data: {
          network: context.network,
          elements: data
        }
      }));
    });
  });

  const options = Object.assign(opts, context.options);
  delete options._;

  await scopedRedisClient((client, prefix) => client.publish(prefix, JSON.stringify({
    type: 'discord:createGetEndpoint',
    data: {
      name,
      renderType: 'digest',
      options
    }
  })));

  const embed = new MessageEmbed()
    .setColor('DARK_GOLD')
    .setTitle(`Serving **${data.length}**-message digest for \`${context.network}\``)
    .setDescription(fqUrlFromPath(name));

  if (options.ttl === -1) {
    embed.addField('Forever URL', fqUrlFromPath(`static/${name}.html`));
  } else {
    const ttlSecs = options.ttl ? options.ttl * 60 : config.http.ttlSecs;
    embed.addField('Expires', `${ttlSecs / 60} minutes`);
  }

  context.sendToBotChan({ embeds: [embed] }, true);
}

async function servePage (context, data, renderType, callback) {
  if (!context || !data || !renderType) {
    throw new Error('not enough args');
  }

  const name = nanoid();

  context.registerOneTimeHandler('http:get-req:' + name, name, async () => {
    await scopedRedisClient(async (r) => {
      await r.publish(PREFIX, JSON.stringify({
        type: 'http:get-res:' + name,
        data
      }));

      if (callback) {
        callback(context);
      }
    });
  });

  const options = Object.assign({}, context.options);
  delete options._;

  await context.publish({
    type: 'discord:createGetEndpoint',
    data: {
      name,
      renderType,
      options
    }
  });

  return name;
}

module.exports = {
  serveMessages,
  servePage
};
