'use strict';

const fs = require('fs');
const path = require('path');
const { PREFIX, NAME, VERSION, expiryFromOptions } = require('./util');
const config = require('config');
const Redis = require('ioredis');
const mustache = require('mustache');
const { nanoid } = require('nanoid');
const { Readable } = require('stream');
const { finished } = require('stream/promises');

const app = require('fastify')({
  logger: true
});

require('./logger')('http');

const redisListener = new Redis(config.app.redis);

const stats = { // eslint-disable-line no-unused-vars
  upSince: new Date()
};

const registered = {
  get: {}
};

const renderCache = {};

let templates;
function templatesLoad () {
  const templatePath = path.join(__dirname, 'http', 'templates');
  templates = fs.readdirSync(templatePath).reduce((a, tmplPath) => {
    const { name } = path.parse(tmplPath);
    return {
      [name]: () => fs.readFileSync(path.join(templatePath, tmplPath)).toString('utf8'),
      ...a
    };
  }, {});

  console.log(`Loaded templates: ${Object.keys(templates).join(', ')}`);
}

process.on('SIGUSR1', () => {
  console.log('SIGUSR1 received, reloading templates');
  templatesLoad();
});

templatesLoad();

function mkdirSyncIgnoreExist (dirPath) {
  try {
    fs.mkdirSync(dirPath);
  } catch (e) {
    if (e.code !== 'EEXIST') {
      throw e;
    }
  }
}

redisListener.subscribe(PREFIX, (err) => {
  if (err) {
    throw err;
  }

  console.log('Connected to Redis');

  const reqPubClient = new Redis(config.redis.url);

  mkdirSyncIgnoreExist(config.http.staticDir);

  if (config.http.attachmentsDir) {
    const { attachmentsDir } = config.http;
    mkdirSyncIgnoreExist(attachmentsDir);

    app.get('/attachments/:name', async (req, res) => {
      const attachmentPath = path.join(attachmentsDir, req.params.name);

      try {
        console.log(`serving ${attachmentPath}`);
        return res.send(await fs.promises.readFile(attachmentPath));
      } catch (e) {
        console.error(`failed to send ${attachmentPath}:`, e);
        return res.redirect(config.http.rootRedirectUrl);
      }
    });
  }

  app.get('/static/:name', async (req, res) => {
    const assetPath = path.join(config.http.staticDir, req.params.name);

    try {
      return res.send(await fs.promises.readFile(assetPath));
    } catch (e) {
      console.error(`failed to send ${assetPath}:`, e);
      return res.redirect(config.http.rootRedirectUrl);
    }
  });

  app.get('/:id', async (req, res) => {
    console.debug(`GET /${req.params.id}`, req.params, req.query);
    const handler = registered.get[req.params.id];

    if (!handler) {
      console.warn('Bad handler!', req.params);
      return res.redirect(config.http.rootRedirectUrl);
    }

    if (Number(new Date()) > handler.exp) {
      console.warn('expiring!', req.params);
      delete registered.get[req.params.id];
      return res.redirect(config.http.rootRedirectUrl);
    }

    if (renderCache[req.params.id]) {
      console.debug('using cached render obj for', req.params.id);
      const { renderType, renderObj } = renderCache[req.params.id];

      if (req.query.json) {
        res.send(renderObj);
      } else {
        res.type('text/html; charset=utf-8').send(mustache.render(templates[renderType](), renderObj));
      }

      return;
    }

    try {
      const { name, renderType } = handler.parsed.data;
      const type = ['http', 'get-req', name].join(':');

      await reqPubClient.publish(PREFIX, JSON.stringify({ type }));
      let body = await handler.promise;

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
        documentExpiresAt: (new Date(handler.exp)).toDRCString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...body
      };

      renderCache[req.params.id] = { renderType, renderObj };

      if (!req.query.json && renderType && templates[renderType]) {
        console.debug('Rendering', renderObj);
        body = mustache.render(templates[renderType](), renderObj);
        res.type('text/html; charset=utf-8');
      }

      res.send(body);
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

            console.log(subSubType, 'Resolving!!');
            handler.resolve(parsed.data);
          }
        }

        if (subType === 'createGetEndpoint') {
          if (!parsed.data.name) {
            throw new Error('bad args for createGetEndpoint');
          }

          const { name, options } = parsed.data;
          console.debug('CREATE!', name, options);

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
        } else if (subType === 'isHTTPRunningRequest' && type === 'discord') {
          const { reqId } = parsed.data;
          console.log('isHTTPRunningRequest reqId', reqId);
          reqPubClient.publish(PREFIX, JSON.stringify({
            type: 'http:isHTTPRunningResponse',
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
