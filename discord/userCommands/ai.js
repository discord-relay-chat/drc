'use strict';

const config = require('config');
const OpenAI = require('openai');
const { Anthropic } = require('@anthropic-ai/sdk');
const marked = require('marked');
const { fqUrlFromPath } = require('../../util');
const { servePage, isHTTPRunning } = require('../common');

require('../../logger')('discord');

// Initialize API clients
const openaiConfig = config.openai;
const anthropicConfig = config.anthropic;
const OAIAPI = new OpenAI({ apiKey: openaiConfig.secretKey, organization: openaiConfig.organization });
const anthropicClient = new Anthropic({ apiKey: anthropicConfig.secretKey });

/**
 * Query OpenAI's API with the given parameters
 * @param {Object} params Parameters for the OpenAI query
 * @returns {Object} The response data
 */
async function queryOpenAI (params) {
  const { prompt, model, temperature, max_tokens } = params;
  const dataObj = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature,
    max_tokens
  };

  const startTime = new Date();
  console.log(`OpenAI Prompt: ${prompt}`);

  const res = await OAIAPI.chat.completions.create(dataObj);

  const responseText = res.choices?.[0]?.message?.content ?? '';
  const queryTimeS = Number((new Date() - startTime) / 1000).toFixed(1);

  return {
    provider: 'openai',
    model,
    prompt,
    temperature,
    max_tokens,
    response: responseText,
    queryTimeS,
    viaHTML: openaiConfig.viaHTML
  };
}

/**
 * Query Anthropic's API with the given parameters
 * @param {Object} params Parameters for the Anthropic query
 * @returns {Object} The response data
 */
async function queryAnthropic (params) {
  const { prompt, model, temperature, max_tokens, system } = params;

  const startTime = new Date();
  console.log(`Anthropic Prompt: ${prompt}`);
  console.log(`Anthropic System: ${system}`);

  const res = await anthropicClient.messages.create({
    model,
    max_tokens,
    temperature,
    messages: [{ role: 'user', content: prompt }],
    system
  });

  const responseText = res.content?.[0]?.text ?? '';
  const queryTimeS = Number((new Date() - startTime) / 1000).toFixed(1);

  return {
    provider: 'anthropic',
    model,
    prompt,
    temperature,
    max_tokens,
    system,
    response: responseText,
    queryTimeS,
    viaHTML: anthropicConfig.viaHTML
  };
}

/**
 * Process a request to a specific AI provider
 * @param {string} provider - The AI provider (openai or anthropic)
 * @param {Object} context - The command context
 * @returns {Promise<Object>} The response from the AI provider
 */
async function processProviderRequest (provider, context) {
  const prompt = context.argObj._.join(' ');
  let providerConfig, modelOption, result;

  if (provider === 'openai') {
    providerConfig = openaiConfig;
    modelOption = context.options?.openaiModel ?? providerConfig.chatModel;

    if (context.options?.listOpenAIModels) {
      return { provider, models: (await OAIAPI.models.list())?.data?.map(({ id }) => id) };
    }

    result = await queryOpenAI({
      prompt,
      model: modelOption,
      temperature: context.options?.temperature ?? providerConfig.temperature,
      max_tokens: context.options?.maxTokens ?? providerConfig.maxTokens
    });
  } else if (provider === 'anthropic') {
    providerConfig = anthropicConfig;
    modelOption = context.options?.anthropicModel ?? providerConfig.model;

    if (context.options?.listAnthropicModels) {
      const models = await anthropicClient.models.list();
      return { provider, models: models?.data?.map(({ id }) => id) };
    }

    result = await queryAnthropic({
      prompt,
      model: modelOption,
      temperature: context.options?.temperature ?? providerConfig.temperature,
      max_tokens: context.options?.maxTokens ?? providerConfig.maxTokens,
      system: context.options?.system ?? providerConfig.system
    });
  }

  return result;
}

async function f (context) {
  // Check for required API keys
  const providers = [];
  if (!openaiConfig.secretKey && !anthropicConfig.secretKey) {
    return 'You must specify at least one secret key in either `config.openai.secretKey` or `config.anthropic.secretKey`!';
  }

  if (openaiConfig.secretKey) providers.push('openai');
  if (anthropicConfig.secretKey) providers.push('anthropic');

  // Handle model listing
  if (context.options?.listModels) {
    const results = [];
    for (const provider of providers) {
      try {
        if (provider === 'openai') {
          const models = (await OAIAPI.models.list())?.data?.map(({ id }) => id);
          results.push(`OpenAI Models: ${models.join(', ')}`);
        } else if (provider === 'anthropic') {
          const models = await anthropicClient.models.list();
          results.push(`Anthropic Models: ${models?.data?.map(({ id }) => id).join(', ')}`);
        }
      } catch (e) {
        results.push(`Error listing ${provider} models: ${e.message}`);
      }
    }
    return results.join('\n\n');
  }

  try {
    // Determine which providers to query
    let requestedProviders = [];

    if (context.options?.openai) {
      requestedProviders.push('openai');
    }

    if (context.options?.claude) {
      requestedProviders.push('anthropic');
    }

    // If no specific provider was requested, use all available
    if (requestedProviders.length === 0) {
      requestedProviders = [...providers];
    }

    // If we're requesting providers that don't have API keys, remove them
    requestedProviders = requestedProviders.filter(p =>
      (p === 'openai' && openaiConfig.secretKey) ||
      (p === 'anthropic' && anthropicConfig.secretKey)
    );

    if (requestedProviders.length === 0) {
      return 'No AI providers are available or specified. Please check your configuration.';
    }

    context.sendToBotChan(`Querying ${requestedProviders.join(' and ')}...`);

    // Query all requested providers
    const responses = await Promise.all(
      requestedProviders.map(provider => processProviderRequest(provider, context))
    );

    // Process the responses
    const prompt = context.argObj._.join(' ');
    const validResponses = responses.filter(r => r && r.response);

    if (validResponses.length === 0) {
      return 'No valid responses received from any AI provider.';
    }

    // Format responses for HTML display
    const formattedResponses = validResponses.map(r => ({
      ...r,
      response: marked.parse(r.response)
    }));

    // Serve the combined results if HTTP is running
    if (await isHTTPRunning(context.registerOneTimeHandler, context.removeOneTimeHandler)) {
      const serveObj = {
        prompt,
        responses: formattedResponses
      };

      const page = await servePage(context, serveObj, 'ai');
      context.sendToBotChan(`This response is also available at ${fqUrlFromPath(page)}`);
    }

    // Return a text version of the responses
    if (validResponses.length === 1) {
      return validResponses[0].response;
    } else {
      return validResponses.map(r => `## ${r.provider.toUpperCase()} (${r.model}):\n${r.response}`).join('\n\n');
    }
  } catch (e) {
    console.log(e);
    const error = e.response?.data?.error?.message ?? e.error?.message ?? e.message;
    return 'ERROR: ' + error;
  }
}

f.__drcHelp = () => ({
  title: 'A unified interface to multiple AI models (OpenAI\'s GPT, Anthropic\'s Claude, etc.)',
  usage: '<options> [prompt]',
  options: [
    ['--openai', 'Use only OpenAI models'],
    ['--claude', 'Use only Anthropic models'],
    ['--openaiModel', 'Specify OpenAI model', true],
    ['--anthropicModel', 'Specify Anthropic model', true],
    ['--maxTokens', 'Set max tokens', true],
    ['--temperature', 'Set temperature', true],
    ['--system', 'Set system prompt for Claude', true],
    ['--listModels', 'List all available models'],
    ['--listOpenAIModels', 'List available OpenAI models'],
    ['--listAnthropicModels', 'List available Anthropic models']
  ],
  notes: 'Run `!config get openai` or `!config get anthropic` to see defaults.'
});

module.exports = f;
