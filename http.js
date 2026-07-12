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
const { startLogStream } = require('./http/liveLogsManager');

// Security helper functions
function sanitizePath (baseDir, userPath) {
  const normalizedBase = path.resolve(baseDir);
  const resolvedPath = path.resolve(normalizedBase, path.normalize(userPath));
  if (!resolvedPath.startsWith(normalizedBase + path.sep) && resolvedPath !== normalizedBase) {
    throw new Error('Path traversal detected');
  }
  return resolvedPath;
}

function isURLSafe (urlString) {
  try {
    const url = new URL(urlString);

    if (url.protocol !== 'https:') {
      return false;
    }

    const hostname = url.hostname;
    const blockedPatterns = [
      /^127\./,
      /^10\./,
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
      /^192\.168\./,
      /^169\.254\./,
      /^localhost$/i,
      /^0\.0\.0\.0$/,
      /^\[::/,
      /^fc00:/i,
      /^fe80:/i
    ];

    if (blockedPatterns.some(pattern => pattern.test(hostname))) {
      return false;
    }

    const allowedDomains = ['cdn.discordapp.com', 'media.discordapp.net'];
    if (!allowedDomains.some(domain => hostname.endsWith(domain))) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

function validateKeyComponent (keyComponent) {
  if (!keyComponent || typeof keyComponent !== 'string') {
    throw new Error('Invalid key component');
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(keyComponent)) {
    throw new Error('Invalid key component');
  }

  if (keyComponent.length > 100) {
    throw new Error('Key component too long');
  }

  return keyComponent;
}

let cachedTemplateNames = null;
const TEMPLATE_TYPES = ['digest', 'claudecode', 'ai'];
function getAvailableTemplateNames () {
  if (cachedTemplateNames) {
    return cachedTemplateNames;
  }

  const templatePath = path.join(__dirname, 'http', 'templates');
  const templateFiles = fs.readdirSync(templatePath);

  cachedTemplateNames = {
    all: new Set(),
    baseTemplates: new Set(),
    digestVariants: new Set(),
    claudecodeVariants: new Set(),
    aiVariants: new Set()
  };

  templateFiles.forEach((file) => {
    const { name } = path.parse(file);
    cachedTemplateNames.all.add(name);

    if (name.startsWith('digest-')) {
      cachedTemplateNames.digestVariants.add(name.substring(7));
    } else if (name.startsWith('ai-')) {
      cachedTemplateNames.aiVariants.add(name.substring(3));
    } else if (name.startsWith('claudecode-')) {
      cachedTemplateNames.claudecodeVariants.add(name.substring(11));
    } else {
      cachedTemplateNames.baseTemplates.add(name);
    }
  });

  return cachedTemplateNames;
}

function validateTemplateName (templateName) {
  if (!templateName || typeof templateName !== 'string') {
    return false;
  }

  const templates = getAvailableTemplateNames();

  if (templates.baseTemplates.has(templateName)) {
    return true;
  }

  if (templateName.startsWith('digest-')) {
    const variant = templateName.substring(7);
    return templates.digestVariants.has(variant);
  }

  if (templateName.startsWith('ai-')) {
    const variant = templateName.substring(3);
    return templates.aiVariants.has(variant);
  }

  if (templateName.startsWith('claudecode-')) {
    const variant = templateName.substring(11);
    return templates.claudecodeVariants.has(variant);
  }

  return false;
}

class ProcessPool {
  constructor (maxConcurrent = 5, maxQueue = 20) {
    this.maxConcurrent = maxConcurrent;
    this.maxQueue = maxQueue;
    this.active = 0;
    this.queue = [];
  }

  async execute (fn) {
    while (this.active >= this.maxConcurrent) {
      if (this.queue.length >= this.maxQueue) {
        throw new Error('Queue full');
      }
      await new Promise(resolve => this.queue.push(resolve));
    }

    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      if (this.queue.length > 0) {
        this.queue.shift()();
      }
    }
  }
}

const inkscapePool = new ProcessPool(5, 20);

const app = require('fastify')({
  logger: true,
  bodyLimit: 1048576 // 1MB global limit
});

// Add WebSocket support
const fastifyWebsocket = require('fastify-websocket');
app.register(fastifyWebsocket, {
  options: { maxPayload: 1048576 } // 1MB
});

require('./logger')('http');

const redisListener = new Redis(config.app.redis);

const registered = {
  get: {}
};

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
  cachedTemplateNames = null;
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

async function renderAndCache (handler, templateParam) {
  const { parsed: { data: { name, renderType, options } } } = handler;
  const type = ['http', 'get-req', name].join(':');

  // the 'get-req' message informs the creator of this endpoint that the
  // data is now needed to complete the request, and...
  await scopedRedisClient((reqPubClient, PREFIX) =>
    reqPubClient.publish(PREFIX, JSON.stringify({ type })));
  // ...(await handler.promise) waits for it to arrive

  // Determine effective render type
  // Priority: 1) query param template, 2) options.template (default), 3) renderType
  let effectiveRenderType = renderType;
  const defaultTemplate = options?.template;

  // Validate base renderType
  if (!validateTemplateName(renderType)) {
    throw new Error(`Invalid renderType: ${renderType}`);
  }

  if (templateParam && TEMPLATE_TYPES.includes(renderType)) {
    // Validate template parameter
    if (typeof templateParam !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(templateParam)) {
      console.warn('Invalid template parameter, using default');
    } else {
      const candidateTemplate = `${renderType}-${templateParam}`;
      if (validateTemplateName(candidateTemplate)) {
        templatesLoad();
        const availableTemplates = getTemplates();
        if (availableTemplates && availableTemplates[candidateTemplate]) {
          effectiveRenderType = candidateTemplate;
        }
      }
    }
  } else if (defaultTemplate && TEMPLATE_TYPES.includes(renderType)) {
    const candidateTemplate = `${renderType}-${defaultTemplate}`;
    if (validateTemplateName(candidateTemplate)) {
      templatesLoad();
      const availableTemplates = getTemplates();
      if (availableTemplates && availableTemplates[candidateTemplate]) {
        effectiveRenderType = candidateTemplate;
      }
    }
  }

  const { body, renderObj } = renderTemplate(effectiveRenderType, (await handler.promise), handler.exp);

  // Store in Redis with expiry time
  const cacheData = { renderType, renderObj, defaultTemplate, exp: handler.exp };
  await scopedRedisClient(async (client, PREFIX) => {
    const cacheKey = `${PREFIX}:renderCache:${name}`;
    await client.set(cacheKey, JSON.stringify(cacheData));

    if (handler.exp) {
      const ttlMs = handler.exp - Date.now();
      if (ttlMs > 0) {
        await client.pexpire(cacheKey, ttlMs);
      }
    }
  });

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
      try {
        const attachmentPath = sanitizePath(attachmentsDir, req.params.name);
        console.log(`serving ${attachmentPath}`);
        const mimeType = mimeTypes.lookup(path.parse(attachmentPath).ext || 'application/octet-stream');
        return res.type(mimeType).send(await fs.promises.readFile(attachmentPath));
      } catch (e) {
        console.error('failed to send attachment:', e.message);
        return res.redirect(config.http.rootRedirectUrl);
      }
    });
  }

  async function staticServe (res, baseDir, userPath) {
    const allowed = {
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.map': 'application/json'
    };

    try {
      const safePath = sanitizePath(baseDir, userPath);
      const { ext } = path.parse(safePath);
      if (!allowed[ext]) {
        return res.redirect(config.http.rootRedirectUrl);
      }

      return res.type(allowed[ext]).send(await fs.promises.readFile(safePath));
    } catch (e) {
      console.error('staticServe error:', e.message);
      return res.redirect(config.http.rootRedirectUrl);
    }
  }

  app.get('/vendored/monaco/*', async (req, res) => {
    return staticServe(res, path.join(__dirname, 'node_modules', 'monaco-editor', 'min', 'vs'), req.params['*']);
  });

  app.get('/min-maps/*', async (req, res) => {
    return staticServe(res, path.join(__dirname, 'node_modules', 'monaco-editor', 'min-maps'), req.params['*']);
  });

  app.get('/js/*', async (req, res) => {
    return staticServe(res, path.join(__dirname, 'http', 'js'), req.params['*']);
  });

  app.get('/templates/common.css', async (req, res) => {
    return staticServe(res, path.join(__dirname, 'http', 'templates'), 'common.css');
  });

  app.get('/templates/ansiToHtml.js', async (req, res) => {
    return staticServe(res, path.join(__dirname, 'http', 'templates'), 'ansiToHtml.js');
  });

  app.get('/templates/templateSwitcher.js', async (req, res) => {
    return staticServe(res, path.join(__dirname, 'http', 'templates'), 'templateSwitcher.js');
  });

  app.get('/static/:name', async (req, res) => {
    try {
      const assetPath = sanitizePath(config.http.staticDir, req.params.name);
      const mimeType = mimeTypes.lookup(path.parse(assetPath).ext || 'application/octet-stream');
      return res.type(mimeType).send(await fs.promises.readFile(assetPath));
    } catch (e) {
      console.error('failed to send static asset:', e.message);
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
    // Check Redis cache
    let cacheEntry;
    try {
      cacheEntry = await scopedRedisClient(async (client, PREFIX) => {
        const cacheKey = `${PREFIX}:renderCache:${req.params.id}`;
        const cached = await client.get(cacheKey);
        return cached ? JSON.parse(cached) : null;
      });
    } catch (err) {
      console.error('Error retrieving from Redis cache:', err);
    }

    // If we have a cached render, check expiry and serve it
    if (cacheEntry) {
      // Check if expired (belt-and-suspenders with Redis TTL)
      if (cacheEntry.exp && Number(new Date()) > cacheEntry.exp) {
        console.debug('cached document expired!', req.params.id);
        // Delete from Redis
        await scopedRedisClient(async (client, PREFIX) => {
          await client.del(`${PREFIX}:renderCache:${req.params.id}`);
        });
        return res.redirect(config.http.rootRedirectUrl);
      }

      console.debug('using Redis cached render obj for', req.params.id);
      let { renderType, renderObj, defaultTemplate } = cacheEntry;

      // Validate renderType from cache
      if (!validateTemplateName(renderType)) {
        console.error('Invalid renderType from cache:', renderType);
        return res.redirect(config.http.rootRedirectUrl);
      }

      // Determine effective render type
      // Priority: 1) query param template, 2) defaultTemplate, 3) renderType
      if (req.query.template && TEMPLATE_TYPES.includes(renderType)) {
        // Validate query parameter template name
        if (typeof req.query.template !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(req.query.template)) {
          return res.code(400).send({ error: 'Invalid template parameter' });
        }

        const candidateTemplate = `${renderType}-${req.query.template}`;
        if (validateTemplateName(candidateTemplate)) {
          templatesLoad();
          const availableTemplates = getTemplates();
          if (availableTemplates && availableTemplates[candidateTemplate]) {
            renderType = candidateTemplate;
          }
        }
      } else if (!req.query.template && defaultTemplate && TEMPLATE_TYPES.includes(renderType)) {
        const candidateTemplate = `${renderType}-${defaultTemplate}`;
        if (validateTemplateName(candidateTemplate)) {
          templatesLoad();
          const availableTemplates = getTemplates();
          if (availableTemplates && availableTemplates[candidateTemplate]) {
            renderType = candidateTemplate;
          }
        }
      }

      res.type('text/html; charset=utf-8').send(mustache.render(getTemplates()[renderType](), renderObj));
      return;
    }

    // No cached render, check for handler and expiry
    if (checkForExpiry(req)) {
      return res.redirect(config.http.rootRedirectUrl);
    }

    try {
      const handler = registered.get[req.params.id];
      res.type('text/html; charset=utf-8');
      res.send(await renderAndCache(handler, req.query.template));
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

    try {
      validateKeyComponent(req.params.keyComponent);
      validateKeyComponent(req.params.snippetName);
    } catch (e) {
      console.error('Invalid key component:', e.message);
      return res.code(400).send({ error: 'Invalid parameters' });
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

    try {
      validateKeyComponent(req.params.keyComponent);
      validateKeyComponent(req.params.snippetName);
    } catch (e) {
      console.error('Invalid key component:', e.message);
      return res.code(400).send({ error: 'Invalid parameters' });
    }

    // Validate content-type
    const contentType = req.headers['content-type'];
    if (contentType && !contentType.includes('text/plain') && !contentType.includes('application/json')) {
      return res.code(400).send({ error: 'Invalid content type. Expected text/plain or application/json' });
    }

    // Validate body is string
    if (typeof req.body !== 'string') {
      return res.code(400).send({ error: 'Body must be a string' });
    }

    // Enforce explicit size limit (512KB)
    if (req.body.length > 524288) {
      return res.code(413).send({ error: 'Payload too large. Maximum size is 512KB' });
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

    try {
      validateKeyComponent(req.params.keyComponent);
      validateKeyComponent(req.params.snippetName);
    } catch (e) {
      console.error('Invalid key component:', e.message);
      return res.code(400).send({ error: 'Invalid parameters' });
    }

    // Validate body is string
    if (typeof req.body !== 'string') {
      return res.code(400).send({ error: 'Body must be a string' });
    }

    // Enforce explicit size limit (100KB for state storage)
    if (req.body.length > 102400) {
      return res.code(413).send({ error: 'Payload too large. Maximum size is 100KB' });
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

      if (!name || name.length > 100) {
        return res.code(400).send({ error: 'Invalid name length' });
      }

      if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
        return res.code(400).send({ error: 'Invalid characters in name' });
      }

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

      const pngBuffer = await inkscapePool.execute(async () => {
        const svgCode = multiavatar(name);

        // Create temporary file for the SVG
        const tempId = nanoid();
        const svgPath = path.join(__dirname, 'data', `${tempId}.svg`);

        // Write SVG to temporary file
        await fs.promises.writeFile(svgPath, svgCode);

        try {
          // Convert SVG to PNG using Inkscape
          await new Promise((resolve, reject) => {
            let args = ['-w', '1024', '-h', '1024', svgPath];
            if (isInkscapeVersionLessThan1()) {
              args = ['-z', ...args, '-e'];
            } else {
              args.push('-o');
            }
            args.push(cachedPngPath);

            const inkscape = require('child_process').spawn('inkscape', args, {
              timeout: 10000
            });

            const timeoutId = setTimeout(() => {
              inkscape.kill('SIGKILL');
              reject(new Error('Inkscape process timed out'));
            }, 10000);

            inkscape.on('close', (code) => {
              clearTimeout(timeoutId);
              if (code === null) {
                reject(new Error('Inkscape process timed out'));
              } else if (code === 0) {
                resolve();
              } else {
                reject(new Error(`Inkscape process exited with code ${code}`));
              }
            });

            inkscape.on('error', (err) => {
              clearTimeout(timeoutId);
              reject(err);
            });
          });

          // Read the PNG file
          return await fs.promises.readFile(cachedPngPath);
        } finally {
          // Clean up temporary SVG file
          await fs.promises.unlink(svgPath).catch(() => {});
        }
      });

      return res.type('image/png').send(pngBuffer);
    } catch (e) {
      console.error('Error generating multiavatar:', e);
      if (e.message === 'Queue full') {
        return res.code(503).send({ error: 'Service temporarily unavailable' });
      }
      return res.code(500).send({ error: 'Error generating avatar' });
    }
  });

  // WebSocket endpoint for live logs - register directly instead of using a plugin
  app.get('/ws/liveLogs/:streamId', { websocket: true }, (connection, req) => {
    const { streamId } = req.params;
    console.log(`WebSocket connection established for stream: ${streamId}`);

    // Validate streamId format (nanoid pattern or debug-test)
    if (streamId !== 'debug-test' && !/^[A-Za-z0-9_-]{21}$/.test(streamId)) {
      connection.socket.send(JSON.stringify({
        type: 'error',
        message: 'Invalid stream ID format'
      }));
      connection.socket.close();
      return;
    }

    // Special handling for debug test
    if (streamId === 'debug-test') {
      console.log('Debug test WebSocket connection established');

      // Send test data
      connection.socket.send(JSON.stringify({
        type: 'info',
        message: 'This is a debug test connection - WebSocket is working!',
        timestamp: Date.now()
      }));

      // Keep connection open for testing
      const interval = setInterval(() => {
        if (connection.socket.readyState === 1) {
          connection.socket.send(JSON.stringify({
            type: 'log',
            message: `Test log message at ${new Date().toISOString()}`,
            timestamp: Date.now()
          }));
        } else {
          clearInterval(interval);
        }
      }, 5000);

      // Clean up on close
      connection.socket.on('close', () => {
        clearInterval(interval);
        console.log('Debug test WebSocket connection closed');
      });

      return;
    }

    // Find the active log stream in Redis for real streams
    scopedRedisClient(async (client, prefix) => {
      console.log(`Checking Redis for stream info: ${prefix}:liveLogs:${streamId}`);
      const streamInfo = await client.get(`${prefix}:liveLogs:${streamId}`);

      if (!streamInfo) {
        console.log(`No stream found for ID: ${streamId}`);
        connection.socket.send(JSON.stringify({
          type: 'error',
          message: 'Stream not found or expired'
        }));
        connection.socket.close();
        return;
      }

      try {
        const streamData = JSON.parse(streamInfo);

        // Check expiry
        if (Date.now() > streamData.expiresAt) {
          console.log(`Stream expired: ${streamId}`);
          connection.socket.send(JSON.stringify({
            type: 'error',
            message: 'Stream has expired'
          }));
          connection.socket.close();

          // Clean up Redis
          client.del(`${prefix}:liveLogs:${streamId}`);
          return;
        }

        // Send initial connection confirmation
        connection.socket.send(JSON.stringify({
          type: 'connected',
          daemon: streamData.daemon,
          expiresAt: streamData.expiresAt
        }));

        // Set up a subscription for this stream ID
        const streamSubscriber = new Redis(config.app.redis);
        const streamChannel = `${prefix}:liveLogs:stream:${streamId}`;

        // Subscribe to the Redis channel where log messages will be published
        streamSubscriber.subscribe(streamChannel, (err) => {
          if (err) {
            console.error(`Error subscribing to ${streamChannel}:`, err);
            connection.socket.close();
            return;
          }

          console.log(`Subscribed to ${streamChannel}`);
        });

        // Forward messages from Redis to the WebSocket client
        streamSubscriber.on('message', (_channel, message) => {
          if (connection.socket.readyState === 1) { // OPEN
            connection.socket.send(message);
          }
        });

        // Handle connection close
        connection.socket.on('close', () => {
          console.log(`WebSocket connection closed for stream: ${streamId}`);
          streamSubscriber.unsubscribe(streamChannel);
          streamSubscriber.quit();
        });

        // Publish presence information so the log manager daemon knows a client is connected
        client.publish(`${prefix}:liveLogs:presence:${streamId}`, JSON.stringify({
          type: 'clientConnected',
          timestamp: Date.now()
        }));

        // Request the log stream from the external logmgr daemon if not already running
        // Note: The external daemon will handle starting and managing the stream
        console.log(`Ensuring log stream is active for ${streamId}...`);
        startLogStream(streamData)
          .then(success => {
            if (success) {
              console.log(`Stream ${streamId} is active`);
            } else {
              console.warn(`Stream ${streamId} setup reported issues but will try to continue`);
            }
          })
          // This catch block should never be hit with the updated startLogStream implementation,
          // but we'll keep it as a safeguard
          .catch(error => {
            console.error(`Unexpected error with stream ${streamId}:`, error);
          });
      } catch (error) {
        console.error(`Error handling WebSocket for stream ${streamId}:`, error);
        connection.socket.send(JSON.stringify({
          type: 'error',
          message: 'Internal server error'
        }));
        connection.socket.close();
      }
    });
  });

  app.get('/api/templates', async (req, res) => {
    cachedTemplateNames = null;
    const templates = getAvailableTemplateNames();
    return res.type('application/json').send({
      digestVariants: Array.from(templates.digestVariants).sort(),
      aiVariants: Array.from(templates.aiVariants).sort(),
      claudecodeVariants: Array.from(templates.claudecodeVariants).sort(),
      baseTemplates: Array.from(templates.baseTemplates).sort()
    });
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

            // Debug for AI responses
            if (handler.parsed?.data?.renderType === 'ai' && parsed.data?.responses) {
              console.log(`HTTP received data with ${parsed.data.responses.length} responses for AI template`);
              console.log(`Models in HTTP payload: ${parsed.data.responses.map(r => r.model).join(', ')}`);
            }

            // Handle liveLogs initialization asynchronously
            if (handler.parsed?.data?.renderType === 'liveLogs' && parsed.data?.streamId) {
              console.log(`Received liveLogs request for: ${parsed.data.daemon}, streamId: ${parsed.data.streamId}`);

              // Store the stream info in Redis so both the HTTP server and logmgr daemon can access it
              scopedRedisClient(async (client, prefix) => {
                // Store the stream info with expiry
                const streamKey = `${prefix}:liveLogs:${parsed.data.streamId}`;
                await client.set(streamKey, JSON.stringify(parsed.data));

                // Set expiry on the key
                const ttlMs = parsed.data.expiresAt - Date.now();
                if (ttlMs > 0) {
                  await client.pexpire(streamKey, ttlMs);
                }

                console.log(`Stream info stored in Redis with key ${streamKey}, TTL: ${Math.floor(ttlMs / 1000)}s`);
              });

              // We don't start the stream directly - it will be started when a WebSocket client connects
              // This avoids creating unused streams when nobody visits the page
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
                if (!isURLSafe(attachmentURL)) {
                  throw new Error('Invalid or unsafe URL');
                }

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
