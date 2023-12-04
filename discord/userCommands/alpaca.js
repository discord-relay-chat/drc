'use strict';

const config = require('config').alpaca;
const { fqUrlFromPath, scopedRedisClient } = require('../../util');
const { servePage, isHTTPRunning } = require('../common');

const MODEL_ENDPOINTS = Object.fromEntries(Object.entries(config.hosts)
  .flatMap(([hostname, { models, scheme }]) =>
    models.map((model) => ([model, {
      endpoint: `${scheme}://${model}.${hostname}`
    }]))));

async function waitForResponse (endpoint, promptId, queuePosition, model, logger) {
  const getUrl = `${endpoint}/prompt/${promptId}`;
  logger(`🕓 Waiting on \`${model}\` at ${endpoint}/?id=${promptId} in queue position #${queuePosition + 1}...`);

  let getStatus;
  let getResponse;
  do {
    const getRes = await fetch(getUrl); // eslint-disable-line no-undef
    getStatus = getRes.status;
    getResponse = await getRes.json();
    if (getResponse?.queuePosition !== queuePosition) {
      if (getResponse?.queuePosition) {
        logger(`🕓 Have moved up to queue position #${getResponse.queuePosition + 1} for prompt ID \`${promptId}\`...`);
      } else {
        logger(`🕓 Prompt ID \`${promptId}\` has begun processing...`);
      }
      queuePosition = getResponse?.queuePosition;
    }
    await new Promise((resolve) => setTimeout(resolve, config.waitTimeSeconds * 1000));
  } while (getStatus === 202);

  return [promptId, getResponse, model];
}

async function promptAndWait (prompt, endpoint, logger, options) {
  const model = options?.model ?? config.defaultModel;
  const mirostat = options?.mirostat ?? 0;
  const headers = {};
  let priority = 'NORMAL';

  if (config.apiKey?.length) {
    headers.Authorization = `Basic ${Buffer.from(`:${config.apiKey}`, 'utf8').toString('base64')}`;
    priority = 'HIGH';
  }

  const promptRes = await fetch(`${endpoint}/prompt`, { // eslint-disable-line no-undef
    method: 'POST',
    headers,
    body: JSON.stringify({
      prompt,
      model,
      priority,
      mirostat
    })
  });

  if (!promptRes.ok) {
    console.error(promptRes.status, promptRes.statusText, endpoint, prompt);
    throw new Error(`bad prompt: ${promptRes.statusText}`);
  }

  const { promptId, queuePosition } = await promptRes.json();
  return waitForResponse(endpoint, promptId, queuePosition, model, logger);
}

async function announceResult (endpoint, model, promptId, { prompt, response, elapsed_ms, ms_per_token, tokens }, context, models) { // eslint-disable-line camelcase
  context.sendToBotChan(`➡️ Response from ${endpoint} (model: \`${model}\`) to your prompt "_${prompt}_" ` +
  `(${Number(elapsed_ms).toFixed(1)}ms, ${Number(ms_per_token).toFixed(1)}ms/token):\n\`\`\`\n${response}\n\`\`\`\n`);
  if (await isHTTPRunning(context.registerOneTimeHandler, context.removeOneTimeHandler)) {
    const serveObj = {
      prompt,
      response: response.replaceAll(/^\s+/g, '')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('\n', '\n<br/>'),
      queryTimeS: Number(elapsed_ms / 1000.0).toFixed(2), // eslint-disable-line camelcase,
      numTokens: tokens,
      queryTimePerTokenMs: Number(ms_per_token).toFixed(1),
      model: {
        name: model,
        ...models[model]
      }
    };
    console.log('serveObj', serveObj);
    const page = await servePage(context, serveObj, 'gpt');
    let respStr = `This response is also available at ${fqUrlFromPath(page)}`;
    if (config.camelidaeFrontendAvailable) {
      respStr += ` & ${endpoint}?id=${promptId}`;
    }
    context.sendToBotChan(respStr);
  }
}

async function f (context, ...a) {
  const activeEps = await Promise.all(Object.values(MODEL_ENDPOINTS).map(async ({ endpoint }) => ({
    endpoint,
    models: await (await fetch(`${endpoint}/models`)).json()
  })));

  if (context.options.listModels) {
    activeEps.forEach(({ endpoint, models }) => context.sendToBotChan(
      `Models available at **${endpoint}**:\n\n` + Object.keys(models).join('\n')
    ));
    return;
  }

  if (context.options.latchOn) {
    const found = (await Promise.all(activeEps.map(async ({ endpoint, models }) => {
      const res = await fetch(`${endpoint}/prompt/${context.options.latchOn}`);

      if (res.ok && (res.status === 200 || res.status === 202)) {
        return { ...(await res.json()), endpoint, models };
      }

      return null;
    })))
      .filter((i) => !!i);

    if (!found.length) {
      return 'No prompts with that ID found at any endpoint';
    }

    if (found.length > 1) {
      context.sendToBotChan('Multiple prompt IDs found!? That\'s rare...');
      context.sendToBotChan(found);
    }

    const [{ model, queuePosition, endpoint, models }] = found;
    const [promptId, respObj] = await waitForResponse(endpoint, context.options.latchOn, queuePosition, model, context.sendToBotChan);
    return announceResult(endpoint, model, promptId, respObj, context, models);
  }

  if (context.options.model) {
    activeEps.forEach(async ({ endpoint, models }) => {
      if (!Object.keys(models).includes(context.options.model)) {
        throw new Error(`Model "${context.options.model}" is unknown by ${endpoint}!`);
      }
    });
  }

  const prompt = context.argObj._.join(' ');
  context.publish = async (msg) => scopedRedisClient((client, pfx) => client.publish(pfx, JSON.stringify(msg)));
  if (!context.options.ttl) {
    context.options.ttl = -1;
  }

  activeEps.forEach(({ endpoint, models }) =>
    promptAndWait(prompt, endpoint, context.sendToBotChan, context.options)
      .then(async ([promptId, respObj, model]) => { // eslint-disable-line camelcase
        return announceResult(endpoint, model, promptId, respObj, context, models);
      })
      .catch((err) => {
        console.error('Alpaca failed: ', err);
        context.sendToBotChan(`Alpaca request failed: ${err.message}`);
      })
  ); // eslint-disable-line camelcase

  return 'The 🦙 will take awhile to respond...';
}

module.exports = f;
