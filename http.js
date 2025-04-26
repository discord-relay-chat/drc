'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PREFIX, scopedRedisClient } = require('./util');
const config = require('config');
const Redis = require('ioredis');
const mustache = require('mustache');
const { nanoid } = require('nanoid');
const { Readable } = require('stream');
const { finished } = require('stream/promises');
const { ESLint } = require('eslint');
const { renderTemplate, templatesLoad, getTemplates } = require('./http/common');
const mimeTypes = require('mime-types');
const { expiryFromOptions } = require('./lib/expiry');
const { requestCounter, notFoundCounter, responseCounter } = require('./http/promMetrics');
const multiavatar = require('@multiavatar/multiavatar');
const { execSync } = require('child_process');

const app = require('fastify')({
  logger: true
});

require('./logger')('http');

const redisListener = new Redis(config.app.redis);

const registered = {
  get: {}
};

const renderCache = {};

const linter = new ESLint({
  useEslintrc: false,
  overrideConfig: {
    extends: ['eslint:recommended'],
    parserOptions: {
      sourceType: 'module',
      ecmaVersion: 'latest'
    },
    env: {
      node: true
    }
  }
});

process.on('SIGUSR1', () => {
  console.log('SIGUSR1 received, reloading templates');
  templatesLoad(true);
});

let cachedInkscapeVersion = null;

function getInkscapeVersion () {
  if (cachedInkscapeVersion !== null) {
    return cachedInkscapeVersion;
  }

  try {
    const output = execSync('inkscape -V', { encoding: 'utf8' });
    const versionMatch = output.match(/Inkscape (\d+\.\d+\.\d+)/);
    if (versionMatch && versionMatch[1]) {
      cachedInkscapeVersion = versionMatch[1];
    }
  } catch (e) {
    cachedInkscapeVersion = '0.0.0'; // Default version if not found
    console.error('Error checking Inkscape version:', e);
  }

  return cachedInkscapeVersion;
}

function isInkscapeVersionLessThan1 () {
  const version = getInkscapeVersion();
  const majorVersion = parseFloat(version.split('.')[0]);
  return majorVersion < 1;
}

async function createShrtned (fromUrl) {
  if (!config.http.shrtnHost) {
    return null;
  }

  const headers = {
    Accept: 'application/json'
  };

  if (config.http.shrtnCreds?.user && config.http.shrtnCreds?.pass) {
    const { user, pass } = config.http.shrtnCreds;
    headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`, 'utf-8').toString('base64')}`;
  }

  const response = await fetch(config.http.shrtnHost + '/add', {
    method: 'POST',
    body: fromUrl,
    headers
  });

  if (!response.ok) {
    console.error(`Shrtn request failed: ${response.status} "${response.statusText}"`);
    return null;
  }

  const { redirect } = await response.json();
  return `${config.http.shrtnHost}/${redirect}`;
}

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

  const PutAllowedIds = {};
  const reqPubClient = new Redis(config.redis.url);

  mkdirSyncIgnoreExist(config.http.staticDir);
  console.log(`Using static path: ${config.http.staticDir}`);

  mkdirSyncIgnoreExist(path.join(__dirname, 'data'));
  console.log(`Using data directory: ${path.join(__dirname, 'data')}`);

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

  async function staticServe (res, p) {
    const allowed = {
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.map': 'application/json'
    };

    const { ext } = path.parse(p);
    if (!allowed[ext]) {
      return res.redirect(config.http.rootRedirectUrl);
    }

    return res.type(allowed[ext]).send(await fs.promises.readFile(p));
  }

  app.get('/vendored/monaco/*', async (req, res) => {
    return staticServe(res, path.join(__dirname, 'node_modules', 'monaco-editor', 'min', 'vs', req.params['*']));
  });

  app.get('/min-maps/*', async (req, res) => {
    return staticServe(res, path.join(__dirname, 'node_modules', 'monaco-editor', 'min-maps', req.params['*']));
  });

  app.get('/js/*', async (req, res) => {
    return staticServe(res, path.join(__dirname, 'http', 'js', req.params['*']));
  });

  app.get('/templates/common.css', async (req, res) => {
    return res.type('text/css').send(await fs.promises.readFile(path.join(__dirname, 'http', 'templates', 'common.css')));
  });

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

  function checkForExpiry (req) {
    const handler = registered.get[req.params.id];

    if (!handler) {
      console.debug('Bad handler!', req.params);
      return true;
    }

    if (handler.exp && Number(new Date()) > handler.exp) {
      console.debug('expiring!', req.params);
      delete registered.get[req.params.id];
      delete PutAllowedIds[req.params.id];
      return true;
    }

    return false;
  }

  app.get('/:id', async (req, res) => {
    if (checkForExpiry(req)) {
      return res.redirect(config.http.rootRedirectUrl);
    }

    if (renderCache[req.params.id]) {
      console.debug('using cached render obj for', req.params.id);
      const { renderType, renderObj } = renderCache[req.params.id];
      res.type('text/html; charset=utf-8').send(mustache.render(getTemplates()[renderType](), renderObj));
      return;
    }

    try {
      const handler = registered.get[req.params.id];
      res.type('text/html; charset=utf-8');
      res.send(await renderAndCache(handler));
    } catch (err) {
      console.error(err);
      res.redirect(config.http.rootRedirectUrl);
    }
  });

  // gets script state
  app.get('/:id/:keyComponent/:snippetName', async (req, res) => {
    if (checkForExpiry(req)) {
      return res.redirect(config.http.rootRedirectUrl);
    }

    if (!PutAllowedIds[req.params.id] || !req.params.snippetName || !req.params.keyComponent) {
      return res.redirect(config.http.rootRedirectUrl);
    }

    const { name, keyComponent } = PutAllowedIds[req.params.id];
    if (keyComponent !== req.params.keyComponent || name !== req.params.snippetName) {
      return res.redirect(config.http.rootRedirectUrl);
    }

    // this REALLY needs to be a proper IPC!!!!!!!
    const RKEY = `${PREFIX}:${req.params.keyComponent}:state`;
    return res.type('application/json').send(
      await scopedRedisClient((r) => r.hget(RKEY, req.params.snippetName))
    );
  });

  // linter
  app.patch('/:id/:keyComponent/:snippetName', async (req, res) => {
    if (checkForExpiry(req)) {
      return res.redirect(config.http.rootRedirectUrl);
    }

    if (!PutAllowedIds[req.params.id] || !req.params.snippetName || !req.params.keyComponent) {
      return res.redirect(config.http.rootRedirectUrl);
    }

    const src = '(async function () {\n' + req.body + '\n})();';
    const linted = await linter.lintText(src);
    return res.send({
      linted,
      formatted: {
        html: (await linter.loadFormatter('html')).format(linted),
        json: (await linter.loadFormatter('json')).format(linted)
      }
    });
  });

  app.put('/:id/:keyComponent/:snippetName', async (req, res) => {
    if (checkForExpiry(req)) {
      return res.redirect(config.http.rootRedirectUrl);
    }

    if (!PutAllowedIds[req.params.id] || !req.params.snippetName || !req.params.keyComponent) {
      return res.redirect(config.http.rootRedirectUrl);
    }

    // this REALLY needs to be a proper IPC!!!!!!!
    const RKEY = `${PREFIX}:${req.params.keyComponent}`;
    await scopedRedisClient((r) => r.hset(RKEY, req.params.snippetName, req.body));
    return res.code(204).send();
  });

  app.get('/multiavatar/:name', async (req, res) => {
    const apiKey = req.query.apiKey;
    if (!apiKey) {
      return res.code(401).send({ error: 'API key required' });
    }

    const validKey = await scopedRedisClient((c, p) => c.get(`${p}:multiavatar:apiKey`));
    if (apiKey !== validKey) {
      return res.code(403).send({ error: 'Invalid API key' });
    }

    try {
      const { name } = req.params;

      // Create a hash of the name for safe caching
      const nameHash = crypto.createHash('sha256').update(name).digest('hex');
      const cachedPngPath = path.join(__dirname, 'data', `${nameHash}.png`);

      // Check if we already have a cached version
      try {
        const cachedFile = await fs.promises.stat(cachedPngPath);
        if (cachedFile.isFile()) {
          console.log(`Using cached avatar for: ${name}`);
          const pngBuffer = await fs.promises.readFile(cachedPngPath);
          return res.type('image/png').send(pngBuffer);
        }
      } catch (err) {
        // File doesn't exist, need to generate it
        if (err.code !== 'ENOENT') {
          console.error('Error checking cached file:', err);
        }
      }

      console.log(`Generating new avatar for: ${name}`);
      const svgCode = multiavatar(name);

      // Create temporary file for the SVG
      const tempId = nanoid();
      const svgPath = path.join(__dirname, 'data', `${tempId}.svg`);

      // Write SVG to temporary file
      await fs.promises.writeFile(svgPath, svgCode);

      // Convert SVG to PNG using Inkscape
      await new Promise((resolve, reject) => {
        let args = ['-w', '1024', '-h', '1024', svgPath];
        if (isInkscapeVersionLessThan1()) {
          args = ['-z', ...args, '-e'];
        } else {
          args.push('-o');
        }
        args.push(cachedPngPath);

        const inkscape = require('child_process').spawn('inkscape', args);

        inkscape.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Inkscape process exited with code ${code}`));
          }
        });

        inkscape.on('error', reject);
      });

      // Clean up temporary SVG file
      await fs.promises.unlink(svgPath).catch(() => {});

      // Read the PNG file
      const pngBuffer = await fs.promises.readFile(cachedPngPath);
      return res.type('image/png').send(pngBuffer);
    } catch (e) {
      console.error('Error generating multiavatar:', e);
      return res.code(500).send({ error: 'Error generating avatar' });
    }
  });

  app.get('/', async (req, res) => {
    res.redirect(config.http.rootRedirectUrl);
  });

  app.setNotFoundHandler((req, _res) => {
    console.warn('404 Not Found', { method: req.method, path: req.url });
    notFoundCounter.inc({ method: req.method, path: req.url });
  });

  app.addHook('onRequest', (req, _res, done) => {
    const { method, url } = req.context.config;
    if (!method || !url) {
      return done();
    }

    requestCounter.inc({ method, path: url });
    done();
  });

  app.addHook('onResponse', (req, res, done) => {
    const { method, url } = req.context.config;
    responseCounter.inc({ method, path: url, code: res.statusCode });
    done();
  });

  process.on('SIGINT', () => {
    console.log('Exiting...');
    redisListener.disconnect();
    app.close();
    process.exit(0);
  });

  app.listen({ host: config.http.host, port: config.http.port }, (err, addr) => {
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

            if (PutAllowedIds[subSubType] === true) {
              const { name, keyComponent } = parsed.data;
              PutAllowedIds[subSubType] = { name, keyComponent };
            }

            handler.resolve(parsed.data);
          }
        }

        if (subType === 'createGetEndpoint') {
          if (!parsed.data.name) {
            throw new Error('bad args for createGetEndpoint');
          }

          const { name, options } = parsed.data;
          const exp = expiryFromOptions(options);

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

          if (parsed.data.allowPut) {
            PutAllowedIds[name] = true; // clean this up on expiry of `name` (id)!
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

                data.attachmentURLShort = await createShrtned(attachmentURL);

                if (!fetchRes.ok) {
                  throw new Error(fetchRes.statusText);
                }

                const newId = nanoid() + ext;
                const outPath = path.join(config.http.attachmentsDir, newId);
                const outStream = fs.createWriteStream(outPath);
                await finished(Readable.fromWeb(fetchRes.body).pipe(outStream));
                console.log(`Cached attachment ${newId} from source ${attachmentURL}`);
                data.cachedURL = config.http.proto + '://' + config.http.fqdn + '/attachments/' + newId;
                data.cachedURLShort = await createShrtned(data.cachedURL);
              } catch (e) {
                console.error(`Fetching or persisting ${attachmentURL} failed:`, e.message);
                console.error(e);
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
