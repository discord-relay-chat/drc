'use strict';

const config = require('config');
const Redis = require('ioredis');
const { PREFIX, isObjPathExtant } = require('../util');

module.exports = async function ({ event, path, value, optionalPath, quiet, terse, long, insensitive }) {
  if (value && !path) {
    throw new Error('Cannot use -v without -p!');
  }

  if (optionalPath && !Array.isArray(optionalPath)) {
    optionalPath = [optionalPath];
  }

  const client = new Redis(config.redis.url);
  const rxOpts = 'g' + (insensitive ? 'i' : '');
  const evRx = new RegExp(event, rxOpts);
  const valueRx = value && new RegExp(value, rxOpts);
  let longestTypeLen = 0;
  let longestOptPathLen;

  if (optionalPath && long) {
    longestOptPathLen = optionalPath.reduce((a, x) => Math.max(x.length, a), 0);
  }

  client.on('pmessage', (_pat, _chan, msg) => {
    try {
      const { type, ...evData } = JSON.parse(msg);
      let pathVal;
      if (type.search(evRx) !== -1) {
        if (path) {
          pathVal = isObjPathExtant(evData, path);

          if (!pathVal) {
            return;
          }

          if (value && (typeof pathVal === 'string' ? pathVal.search(valueRx) === -1 : value !== pathVal)) {
            return;
          }
        }

        longestTypeLen = Math.max(type.length, longestTypeLen);

        console.log(new Date(), type.padEnd(longestTypeLen, ' '),
          (path && pathVal && `${optionalPath ? `${path}=` : ''}"${pathVal}"`) ?? '',
          (optionalPath
            ? optionalPath.map((p) => {
              const val = isObjPathExtant(evData, p);

              if (!val) {
                return '';
              }

              if (long) {
                return `\n${p.padStart(longestOptPathLen, ' ')}:\t${val}`;
              }

              return `${p}="${val}" `;
            }).join('')
            : '') + (long ? '\n' : ''),
          quiet ? '' : (terse ? JSON.stringify(evData) : evData));
      }
    } catch (err) {
      console.error('Failed to parse message!', msg, err);
    }
  });

  console.log(`Listening to /${event}/${rxOpts} events on "${PREFIX}*"` +
  (path ? ` with data path "${path}"` : '') +
  (value ? ` having value "${value}"` : '') +
  `${quiet ? ' (quietly)' : ''}...\n`);
  client.psubscribe(PREFIX + '*');
};
