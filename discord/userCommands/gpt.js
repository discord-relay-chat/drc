'use strict';

const config = require('config').openai;
const OpenAI = require('openai');
const marked = require('marked');
const { fqUrlFromPath } = require('../../util');
const { servePage, isHTTPRunning } = require('../common');

require('../../logger')('discord');

const OAIAPI = new OpenAI({ apiKey: config.secretKey, organization: config.organization });

async function f (context, ...a) {
  if (!config.secretKey) {
    return 'You must specify your secret key in `config.openai.secretKey`!';
  }

  let error = 'Unknown error';
  try {
    const prompt = context.argObj._.join(' ');
    const model = context.options?.model ?? (context.options?.chat ? config.chatModel : config.model);
    const temperature = context.options?.temperature ?? config.temperature;
    const max_tokens = context.options?.maxTokens ?? config.maxTokens; // eslint-disable-line camelcase
    const dataObj = {
      model,
      prompt,
      temperature,
      max_tokens
    };

    const startTime = new Date();
    context.sendToBotChan('Querying OpenAI...');

    if (context.options?.listModels) {
      return (await OAIAPI.models.list())?.data?.map(({ id }) => id);
    }

    delete dataObj.prompt;
    console.log(`Prompt: ${prompt}`);
    dataObj.messages = [{ role: 'user', content: prompt }];
    const res = await OAIAPI.chat.completions.create(dataObj);
    dataObj.prompt = prompt; // createChatCompletion balks at it, but serverPage needs it
    dataObj.response = res.choices?.[0]?.message?.content ?? res.data;

    if (res.choices?.length > 1) {
      context.sendToBotChan('Multiple responses!');
      context.sendToBotChan(res.choices);
    }

    const queryTimeS = Number((new Date() - startTime) / 1000).toFixed(1);
    context.sendToBotChan(`OpenAI query took ${queryTimeS} seconds`);
    if (await isHTTPRunning(context.registerOneTimeHandler, context.removeOneTimeHandler)) {
      const serveObj = {
        ...dataObj,
        queryTimeS,
        response: marked.parse(dataObj.response),
        viaHTML: config.viaHTML,
        model: {
          name: model
        }
      };

      const page = await servePage(context, serveObj, 'gpt');
      context.sendToBotChan(`This response is also available at ${fqUrlFromPath(page)}`);
    }

    return dataObj.response;
  } catch (e) {
    console.log(e);
    error = e.response?.data?.error?.message ?? e.message;
  }

  return 'ERROR: ' + error;
}

f.__drcHelp = () => ({
  title: 'An interface to OpenAI\'s text completion engine ("GPT" et. al).',
  usage: '<options> [prompt]',
  options: [
    ['--model', 'Change model', true],
    ['--maxTokens', 'Set max tokens', true],
    ['--temperature', 'Set temperature', true],
    ['--listModels', 'List available OpenAI models']
  ],
  notes: 'Run `!config get openai` to see defaults.'
});

module.exports = f;
