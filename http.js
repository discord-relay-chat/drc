'use strict';

const fs = require('fs');
const path = require('path');
const { PREFIX, NAME, VERSION, expiryFromOptions } = require('./util');
const config = require('config');
const Redis = require('ioredis');
const mustache = require('mustache');

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

redisListener.subscribe(PREFIX, (err) => {
  if (err) {
    throw err;
  }

  console.log('Connected to Redis');

  const reqPubClient = new Redis(config.redis.url);

  app.get('/static/:name', async (req, res) => {
    try {
      await fs.promises.mkdir(config.http.staticDir);
    } catch (e) {
      if (e.code !== 'EEXIST') {
        console.error(e);
      }
    }

    const assetPath = path.join(config.http.staticDir, req.params.name);

    try {
      return res.send(await fs.promises.readFile(assetPath));
    } catch (e) {
      console.error(`failed to send ${assetPath}:`, e);
      return res.status(404).send();
    }
  });

  app.get('/:id', async (req, res) => {
    console.debug(`GET /${req.params.id}`, req.params, req.query);
    const handler = registered.get[req.params.id];

    if (!handler) {
      console.warn('Bad handler!', req.params);
      res.status(404).send();
      return;
    }

    if (Number(new Date()) > handler.exp) {
      console.warn('expiring!', req.params);
      delete registered.get[req.params.id];
      res.status(404).send();
      return;
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
      res.status(500).send(JSON.stringify(err));
    }
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
        }
      } catch (e) {
        console.error(e);
      }
    });
  });
});
