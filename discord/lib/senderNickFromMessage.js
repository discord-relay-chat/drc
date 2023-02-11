'use strict';

function senderNickFromMessage (msgObj) {
  // message was sent via our username-interposing webhooks, so we can extract the nick directly
  if (msgObj?.author.bot && msgObj?.author.discriminator === '0000') {
    console.debug('senderNickFromMessage IS A IRC USER INTERPOSED ->', msgObj?.author.username);
    return msgObj?.author.username;
  }

  console.debug('senderNickFromMessage MISSED', msgObj);
}

module.exports = senderNickFromMessage;
