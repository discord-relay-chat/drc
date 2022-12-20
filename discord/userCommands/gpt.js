'use strict';

const config = require('config').openai;
const oai = require('openai');

require('../../logger')('discord');

async function f (context, ...a) {
  if (!config.secretKey) {
    return 'You must specify your secret key in `config.openai.secretKey`!';
  }

  let error = 'Unknown error';
  try {
    const res = await (new oai.OpenAIApi(new oai.Configuration({
      apiKey: config.secretKey
    }))).createCompletion({
      model: context.options.model ?? config.model,
      prompt: a.join(' '),
      temperature: context.options.temperature ?? config.temperature,
      max_tokens: context.options.maxTokens ?? config.maxTokens
    });

    return res.data?.choices?.[0]?.text ?? res.data?.choices ?? res.data;
  } catch (e) {
    error = e.response.data?.error?.message ?? e.message;
  }

  return 'ERROR: ' + error;
}

f.__drcHelp = () => ({
  title: 'An interface to ChatGPT',
  usage: '<options> [prompt]',
  notes: 'Options:\n`--model`: Change model\n`--maxTokens`: Set max tokens\n`--temperature`: Set temperature.\n\nRun `!config get openai` to see defaults.'
});

module.exports = f;
