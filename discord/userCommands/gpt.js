'use strict';

const config = require('config').openai;
const oai = require('openai');
const { fqUrlFromPath } = require('../../util');
const { servePage, isHTTPRunning } = require('../common');

require('../../logger')('discord');

const OAIAPI = new oai.OpenAIApi(new oai.Configuration({
  apiKey: config.secretKey
}));

async function f (context, ...a) {
  if (!config.secretKey) {
    return 'You must specify your secret key in `config.openai.secretKey`!';
  }

  let error = 'Unknown error';
  try {
    const prompt = context.argObj._.join(' ');
    const model = context.options.model ?? (context.options.chat ? config.chatModel : config.model);
    const temperature = context.options.temperature ?? config.temperature;
    const max_tokens = context.options.maxTokens ?? config.maxTokens; // eslint-disable-line camelcase
    const dataObj = {
      model,
      prompt,
      temperature,
      max_tokens
    };

    const startTime = new Date();
    context.sendToBotChan('Querying OpenAI...');

    if (context.options.listModels) {
      return (await OAIAPI.listModels())?.data?.data.map(({ id }) => id);
    }

    if (context.options.chat) {
      delete dataObj.prompt;
      dataObj.messages = [{ role: 'user', content: prompt }];
      const res = await OAIAPI.createChatCompletion(dataObj);
      dataObj.prompt = prompt; // createChatCompletion balks at it, but serverPage needs it
      dataObj.response = res.data?.choices?.[0]?.message?.content ?? res.data;
    } else {
      const res = await OAIAPI.createCompletion(dataObj);
      dataObj.response = res.data?.choices?.[0]?.text ?? res.data?.choices ?? res.data;
    }

    const queryTimeS = Number((new Date() - startTime) / 1000).toFixed(1);
    context.sendToBotChan(`OpenAI query took ${queryTimeS} seconds`);
    if (await isHTTPRunning(context.registerOneTimeHandler, context.removeOneTimeHandler)) {
      const serveObj = {
        ...dataObj,
        queryTimeS,
        response: dataObj.response
          .replaceAll(/^\s+/g, '')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('\n', '\n<br/>'),
        viaHTML: config.viaHTML
      };
      if (!context.options.ttl) {
        context.options.ttl = -1;
      }
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
  notes: 'Options:\n`--model`: Change model\n`--maxTokens`: Set max tokens\n`--temperature`: Set temperature.\n\nRun `!config get openai` to see defaults.'
});

module.exports = f;
