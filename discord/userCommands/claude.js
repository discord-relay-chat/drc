'use strict';

const config = require('config').anthropic;
const { Anthropic } = require('@anthropic-ai/sdk');
const marked = require('marked');
const { fqUrlFromPath } = require('../../util');
const { servePage, isHTTPRunning } = require('../common');

require('../../logger')('discord');

const anthropicClient = new Anthropic({ apiKey: config.secretKey });

async function f (context) {
  if (!config.secretKey) {
    return 'You must specify your secret key in `config.anthropic.secretKey`!';
  }

  let error = 'Unknown error';
  try {
    const prompt = context.argObj._.join(' ');
    const model = context.options?.model ?? config.model;
    const temperature = context.options?.temperature ?? config.temperature;
    const max_tokens = context.options?.maxTokens ?? config.maxTokens; // eslint-disable-line camelcase
    const dataObj = {
      model,
      prompt,
      temperature,
      max_tokens
    };

    const startTime = new Date();
    context.sendToBotChan('Querying Anthropic...');

    if (context.options?.listModels) {
      const models = await anthropicClient.models.list();
      return models?.data?.map(({ id }) => id);
    }

    delete dataObj.prompt;
    const system = context.options?.system ?? config.system;
    console.log(`Prompt: ${prompt}`);
    console.log(`System: ${system}`);
    const res = await anthropicClient.messages.create({
      model,
      max_tokens,
      temperature,
      messages: [{ role: 'user', content: prompt }],
      system
    });

    dataObj.prompt = prompt;
    dataObj.response = res.content?.[0]?.text ?? '';

    const queryTimeS = Number((new Date() - startTime) / 1000).toFixed(1);
    context.sendToBotChan(`Anthropic query took ${queryTimeS} seconds`);
    if (await isHTTPRunning(context.registerOneTimeHandler, context.removeOneTimeHandler)) {
      const serveObj = {
        ...dataObj,
        queryTimeS,
        response: marked.parse(dataObj.response),
        viaHTML: config.viaHTML
      };

      const page = await servePage(context, serveObj, 'claude');
      context.sendToBotChan(`This response is also available at ${fqUrlFromPath(page)}`);
    }

    return dataObj.response;
  } catch (e) {
    console.log(e);
    error = e.error?.message ?? e.message;
  }

  return 'ERROR: ' + error;
}

f.__drcHelp = () => ({
  title: 'An interface to Anthropic\'s Claude AI model.',
  usage: '<options> [prompt]',
  options: [
    ['--model', 'Change model', true],
    ['--maxTokens', 'Set max tokens', true],
    ['--temperature', 'Set temperature', true],
    ['--system', 'Set system prompt', true],
    ['--listModels', 'List available Anthropic models']
  ],
  notes: 'Run `!config get anthropic` to see defaults.'
});

module.exports = f;
