'use strict';

const fs = require('fs');
const path = require('path');
const { PREFIX, expiryFromOptions, scopedRedisClient } = require('./util');
const config = require('config');
const Redis = require('ioredis');
const mustache = require('mustache');
const { nanoid } = require('nanoid');
const { Readable } = require('stream');
const { finished } = require('stream/promises');
const { renderTemplate, templatesLoad, getTemplates } = require('./http/common');
const mimeTypes = require('mime-types');

const app = require('fastify')({
  logger: true
});

require('./logger')('http');

const redisListener = new Redis(config.app.redis);

const registered = {
  get: {}
};

const renderCache = {};

process.on('SIGUSR1', () => {
  console.log('SIGUSR1 received, reloading templates');
  templatesLoad(true);
});

function mkdirSyncIgnoreExist (dirPath) {
  try {
    fs.mkdirSync(dirPath);
  } catch (e) {
    if (!['EACCES', 'EEXIST'].includes(e.code)) {
      throw e;
    }
  }
}

async function renderAndCache (handler) {
  const { parsed: { data: { name, renderType } } } = handler;
  const type = ['http', 'get-req', name].join(':');

  // the 'get-req' message informs the creator of this endpoint that the
  // data is now needed to complete the request, and...
  await scopedRedisClient((reqPubClient, PREFIX) =>
    reqPubClient.publish(PREFIX, JSON.stringify({ type })));
  // ...(await handler.promise) waits for it to arrive
  const { body, renderObj } = renderTemplate(renderType, (await handler.promise), handler.exp);
  renderCache[name] = { renderType, renderObj };

  return body;
}

redisListener.subscribe(PREFIX, (err) => {
  if (err) {
    throw err;
  }

  console.log('Connected to Redis');

  const reqPubClient = new Redis(config.redis.url);

  mkdirSyncIgnoreExist(config.http.staticDir);
  console.log(`Using static path: ${config.http.staticDir}`);

  if (config.http.attachmentsDir) {
    const { attachmentsDir } = config.http;
    mkdirSyncIgnoreExist(attachmentsDir);
    console.log(`Using attachments path: ${attachmentsDir}`);

    app.get('/attachments/:name', async (req, res) => {
      const attachmentPath = path.join(attachmentsDir, req.params.name);

      try {
        console.log(`serving ${attachmentPath}`);
        const mimeType = mimeTypes.lookup(path.parse(attachmentPath).ext || 'application/octet-stream');
        return res.type(mimeType).send(await fs.promises.readFile(attachmentPath));
      } catch (e) {
        console.error(`failed to send ${attachmentPath}:`, e);
        return res.redirect(config.http.rootRedirectUrl);
      }
    });
  }

  app.get('/static/:name', async (req, res) => {
    const assetPath = path.join(config.http.staticDir, req.params.name);
    const mimeType = mimeTypes.lookup(path.parse(assetPath).ext || 'application/octet-stream');

    try {
      return res.type(mimeType).send(await fs.promises.readFile(assetPath));
    } catch (e) {
      console.error(`failed to send ${assetPath}:`, e);
      return res.redirect(config.http.rootRedirectUrl);
    }
  });

  app.get('/:id', async (req, res) => {
    console.log(`GET /${req.params.id}`, req.params, req.query);
    const handler = registered.get[req.params.id];

    if (!handler) {
      console.debug('Bad handler!', req.params);
      return res.redirect(config.http.rootRedirectUrl);
    }

    if (handler.exp && Number(new Date()) > handler.exp) {
      console.debug('expiring!', req.params);
      delete registered.get[req.params.id];
      return res.redirect(config.http.rootRedirectUrl);
    }

    if (renderCache[req.params.id]) {
      console.debug('using cached render obj for', req.params.id);
      const { renderType, renderObj } = renderCache[req.params.id];
      res.type('text/html; charset=utf-8').send(mustache.render(getTemplates()[renderType](), renderObj));
      return;
    }

    try {
      res.type('text/html; charset=utf-8');
      res.send(await renderAndCache(handler));
    } catch (err) {
      console.error(err);
      res.redirect(config.http.rootRedirectUrl);
    }
  });

  app.get('/', async (req, res) => {
    res.redirect(config.http.rootRedirectUrl);
  });

  app.listen(config.http.port, (err, addr) => {
    if (err) {
      throw err;
    }

    console.log(`Listening on ${addr}, using FQDN ${config.http.fqdn}`);

    redisListener.on('message', (chan, msg) => {
      try {
        const parsed = JSON.parse(msg);
        const [type, subType, subSubType] = parsed.type.split(':');

        if (type === 'http') {
          if (subType === 'get-res') {
            const handler = registered.get[subSubType];

            if (!handler) {
              throw new Error('bad handler');
            }

            if (!parsed.data) {
              handler.reject(new Error('no data'));
              return;
            }

            console.log(subSubType, 'Resolving', handler.exp);
            handler.resolve(parsed.data);
          }
        }

        if (subType === 'createGetEndpoint') {
          if (!parsed.data.name) {
            throw new Error('bad args for createGetEndpoint');
          }

          const { name, options } = parsed.data;
          const exp = expiryFromOptions(options);
          console.log('createGetEndpoint', name, options, exp);

          let rr;
          const promise = new Promise((resolve, reject) => {
            rr = { resolve, reject };
          });

          registered.get[name] = {
            exp: expiryFromOptions(options),
            parsed,
            promise,
            ...rr
          };

          // force immediate render if no expiry to generate the static file
          if (!exp) {
            const cachePath = path.join(config.http.staticDir, name + '.html');
            renderAndCache(registered.get[name])
              .then((renderedBody) =>
                fs.promises.writeFile(cachePath, renderedBody))
              .then(() => console.log(`Persisted unexpiring ${cachePath}`))
              .catch((err) => console.log('renderAndCache failed', err));
          }
        } else if (subType === 'isHTTPRunningRequest' && type === 'isXRunning') {
          const { reqId } = parsed.data;
          console.log('isHTTPRunningRequest reqId', reqId);
          reqPubClient.publish(PREFIX, JSON.stringify({
            type: 'isXRunning:isHTTPRunningResponse',
            data: {
              reqId,
              listenAddr: addr,
              fqdn: config.http.fqdn
            }
          }));
        } else if (subType === 'cacheMessageAttachementRequest' && type === 'discord') {
          const { attachmentURL } = parsed.data;
          console.log('cacheMessageAttachement attachmentURL', attachmentURL);

          const innerHandler = async () => {
            const data = { attachmentURL, enabled: !!config.http.attachmentsDir, error: null };

            if (data.enabled) {
              try {
                const { ext } = path.parse((new URL(attachmentURL)).pathname);
                const fetchRes = await fetch(attachmentURL, { // eslint-disable-line no-undef
                  headers: {
                    Accept: '*/*'
                  }
                });

                if (!fetchRes.ok) {
                  throw new Error(fetchRes.statusText);
                }

                const newId = nanoid() + ext;
                const outPath = path.join(config.http.attachmentsDir, newId);
                const outStream = fs.createWriteStream(outPath);
                await finished(Readable.fromWeb(fetchRes.body).pipe(outStream));
                console.log(`Cached attachment ${newId} from source ${attachmentURL}`);
                data.cachedURL = config.http.proto + '://' + config.http.fqdn + '/attachments/' + newId;
              } catch (e) {
                console.error(`Fetching or persisting ${attachmentURL} failed:`, e.message);
                data.error = e.message;
              }
            }

            return data;
          };

          innerHandler().then((data) => {
            reqPubClient.publish(PREFIX, JSON.stringify({
              type: 'http:cacheMessageAttachementResponse',
              data
            }));
          });
        }
      } catch (e) {
        console.error(e);
      }
    });
  });
});
