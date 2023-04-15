'use strict';

const config = require('config').alpaca;
const { fqUrlFromPath, scopedRedisClient } = require('../../util');
const { servePage, isHTTPRunning } = require('../common');

const MODEL_ENDPOINTS = Object.fromEntries(Object.entries(config.hosts).flatMap(([hostname, { models, scheme }]) =>
  models.map((model) => ([model, `${scheme}://${model}.${hostname}/prompt`]))));

async function promptAndWait (prompt, endpoint, logger) {
  const promptRes = await fetch(endpoint, { // eslint-disable-line no-undef
    method: 'POST',
    body: prompt
  });

  if (!promptRes.ok) {
    console.error(promptRes.status, promptRes.statusText, endpoint, prompt);
    throw new Error(`bad prompt: ${promptRes.statusText}`);
  }

  const promptId = (await promptRes.text()).trim();
  const getUrl = `${endpoint}/${promptId}`;
  logger(`🕓 Waiting on ${getUrl} ...`);

  let getStatus;
  let getResponse;
  do {
    const getRes = await fetch(getUrl); // eslint-disable-line no-undef
    getStatus = getRes.status;
    if (getStatus === 200) {
      getResponse = await getRes.json();
    }
    await new Promise((resolve) => setTimeout(resolve, config.waitTimeSeconds * 1000));
  } while (getStatus === 202);

  return [promptId, getResponse];
}

async function f (context, ...a) {
  const activeEps = [];
  if (context.options.model) {
    if (!MODEL_ENDPOINTS[context.options.model]) {
      context.sendToBotChan(`Unknown model "${context.options.model}". ` +
            `Options are: ${Object.keys(MODEL_ENDPOINTS).join(', ')}`);
      return;
    }

    activeEps.push(MODEL_ENDPOINTS[context.options.model]);
  } else {
    activeEps.push(...Object.values(MODEL_ENDPOINTS));
  }

  const prompt = context.argObj._.join(' ');
  context.publish = async (msg) => scopedRedisClient((client, pfx) => client.publish(pfx, JSON.stringify(msg)));
  if (!context.options.ttl) {
    context.options.ttl = -1;
  }

  activeEps.forEach((endpoint) =>
    promptAndWait(prompt, endpoint, context.sendToBotChan)
      .then(async ([promptId, { prompt, response, elapsed_ms, ms_per_token, tokens }]) => { // eslint-disable-line camelcase
        context.sendToBotChan(`➡️ Response from ${endpoint}/${promptId} to your prompt "_${prompt}_" ` +
        `(${Number(elapsed_ms).toFixed(1)}ms, ${Number(ms_per_token).toFixed(1)}ms/token):\n\`\`\`\n${response}\n\`\`\`\n`);
        if (await isHTTPRunning(context.registerOneTimeHandler, context.removeOneTimeHandler)) {
          const serveObj = {
            prompt,
            response: response.replaceAll(/^\s+/g, '')
              .replaceAll('<', '&lt;')
              .replaceAll('>', '&gt;')
              .replaceAll('\n', '\n<br/>'),
            queryTimeS: elapsed_ms / 1000.0, // eslint-disable-line camelcase,
            numTokens: tokens,
            queryTimePerTokenMs: ms_per_token,
            viaHTML: config.viaHTML
          };
          console.log('serveObj', serveObj);
          const page = await servePage(context, serveObj, 'gpt');
          let respStr = `This response is also available at ${fqUrlFromPath(page)}`;
          if (config.camelidaeFrontendAvailable) {
            respStr += ` & ${endpoint.replace('/prompt', '')}?id=${promptId}`;
          }
          context.sendToBotChan(respStr);
        }
      })); // eslint-disable-line camelcase

  return `🦙 Sending your prompt to ${activeEps.length} models. They may take awhile to respond: when they do, the responses will be posted here.`;
}

module.exports = f;
