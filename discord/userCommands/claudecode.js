'use strict';

const config = require('config');
const marked = require('marked');
const { fqUrlFromPath } = require('../../util');
const { servePage, isHTTPRunning } = require('../common');

require('../../logger')('discord');

function stripAnsi (str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

async function f (context) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return 'You must set the ANTHROPIC_API_KEY environment variable!';
  }

  let error = 'Unknown error';
  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    const prompt = context.argObj._.join(' ');
    if (!prompt) {
      return 'ERROR: You must provide a prompt';
    }

    const model = context.options?.model || config.anthropic.claudecode.model;
    const maxTurns = context.options?.maxTurns ? parseInt(context.options.maxTurns, 10) : undefined;
    const permissionMode = context.options?.permissionMode || 'default';
    const cwd = context.options?.cwd || process.cwd();
    const allowedTools = context.options?.allowedTools?.split(',').map(t => t.trim()) ?? ['WebFetch', 'WebSearch'];

    const options = {
      model,
      permissionMode,
      cwd,
      allowedTools
    };

    if (maxTurns !== undefined) {
      options.maxTurns = maxTurns;
    }

    // The Agent SDK replaced the old appendSystemPrompt/customSystemPrompt
    // options with a single `systemPrompt`, and no longer uses Claude Code's
    // system prompt by default, so opt into the preset to preserve prior behavior.
    if (context.options?.customSystemPrompt) {
      options.systemPrompt = context.options.customSystemPrompt;
    } else if (context.options?.appendSystemPrompt) {
      options.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: context.options.appendSystemPrompt
      };
    } else {
      options.systemPrompt = { type: 'preset', preset: 'claude_code' };
    }

    const startTime = new Date();
    context.sendToBotChan('Querying Claude Code...');

    const messages = [];
    let resultText = '';
    let sessionId = '';
    let usage = null;
    let totalCostUsd = 0;
    let numTurns = 0;

    const statusMessages = [];
    const sendAndCaptureStatus = (msg) => {
      statusMessages.push(msg);
      context.sendToBotChan(msg);
    };

    for await (const message of query({ prompt, options })) {
      messages.push(message);

      if (message.type === 'system' && message.subtype === 'init') {
        sessionId = message.session_id;
        sendAndCaptureStatus(`Session started: ${sessionId}`);
        sendAndCaptureStatus(`Model: ${message.model}`);
        sendAndCaptureStatus(`Tools: ${message.tools.join(', ')}`);
        sendAndCaptureStatus(`Allowed tools: ${allowedTools.join(', ')}`);
        sendAndCaptureStatus(`Permission mode: ${message.permissionMode}`);
      } else if (message.type === 'assistant') {
        const content = message.message.content;
        for (const block of content) {
          if (block.type === 'text') {
            sendAndCaptureStatus(`Assistant: ${block.text.substring(0, 200)}${block.text.length > 200 ? '...' : ''}`);
          } else if (block.type === 'tool_use') {
            sendAndCaptureStatus(`Tool: ${block.name}`);
          }
        }
      } else if (message.type === 'result') {
        if (message.subtype === 'success') {
          resultText = message.result;
          usage = message.usage;
          totalCostUsd = message.total_cost_usd;
          numTurns = message.num_turns;
        } else {
          error = `Query ended with error: ${message.subtype}`;
          resultText = error;
        }
      }
    }

    const queryTimeS = Number((new Date() - startTime) / 1000).toFixed(1);
    sendAndCaptureStatus(`Claude Code query took ${queryTimeS} seconds`);

    if (usage) {
      sendAndCaptureStatus(`Turns: ${numTurns}`);
      sendAndCaptureStatus(`Tokens - Input: ${usage.input_tokens}, Output: ${usage.output_tokens}`);
      sendAndCaptureStatus(`Cost: $${totalCostUsd.toFixed(4)}`);
    }

    if (context.options?.showMessages) {
      return JSON.stringify(messages, null, 2);
    }

    const finalResult = resultText || 'No result returned';
    const cleanResult = stripAnsi(finalResult);

    if (await isHTTPRunning(context.registerOneTimeHandler, context.removeOneTimeHandler)) {
      const serveObj = {
        provider: 'claudecode',
        model,
        prompt,
        response: marked.parse(cleanResult),
        queryTimeS,
        sessionId,
        numTurns,
        usage: usage
          ? {
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens
            }
          : null,
        totalCostUsd,
        permissionMode,
        statusMessages,
        hasStatusMessages: statusMessages && statusMessages.length > 0
      };

      const page = await servePage(context, serveObj, 'claudecode');
      const url = fqUrlFromPath(page);
      context.sendToBotChan(`Response available at ${url}`);
      if (context.options?.ttl === -1) {
        context.sendToBotChan('Forever URL: ' + fqUrlFromPath(`static/${page}.html`));
      }
      return url;
    }

    return cleanResult;
  } catch (e) {
    console.error('Claude Code error:', e);
    error = e.message || String(e);
  }

  return 'ERROR: ' + error;
}

f.__drcHelp = () => {
  const config = require('config');
  const cmdPrefix = config.app.allowedSpeakersCommandPrefixCharacter || '!';

  return {
    title: 'An interface to Claude Code Agent SDK.',
    usage: '<options> [prompt]',
    options: [
      ['--model', `Change model (default: ${config.anthropic.claudecode.model})`, true],
      ['--maxTurns', 'Set maximum number of turns', true],
      ['--permissionMode', 'Set permission mode (default, acceptEdits, bypassPermissions, plan)', true],
      ['--cwd', 'Set working directory', true],
      ['--appendSystemPrompt', 'Append to system prompt', true],
      ['--customSystemPrompt', 'Override system prompt', true],
      ['--allowedTools', 'Override allowed tools', true],
      ['--showMessages', 'Show all SDK messages in raw format']
    ],
    notes: `Requires ANTHROPIC_API_KEY environment variable. Run \`${cmdPrefix}claudecode --help\` for more info.`
  };
};

module.exports = f;

if (require.main === module) {
  (async () => {
    console.log('Testing claudecode command...\n');

    const testPrompt = process.argv.slice(2).join(' ') || 'What is 2 + 2? Just tell me the answer briefly.';

    const mockContext = {
      argObj: {
        _: testPrompt.split(' ')
      },
      options: {
        permissionMode: 'bypassPermissions'
      },
      sendToBotChan: (msg) => {
        console.log(`[BOT CHAN] ${msg}`);
      },
      registerOneTimeHandler: () => {},
      removeOneTimeHandler: () => {}
    };

    console.log(`Prompt: "${testPrompt}"\n`);

    try {
      const result = await f(mockContext);
      console.log('\n=== RESULT ===');
      console.log(result);
      console.log('=============\n');
    } catch (e) {
      console.error('Error:', e);
      process.exit(1);
    }
  })();
}
