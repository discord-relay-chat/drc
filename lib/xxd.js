'use strict';

const xxdSplitter = /([a-f0-9]{4})/;
const unprintables = /[^ -~]+/g;

function xxd (buffer, { rowWidth = 32, returnRawLines = false } = {}) {
  if (!(buffer instanceof Buffer)) {
    try {
      buffer = Buffer.from(buffer);
    } catch (err) {
      console.debug('xxd error', err);
      return;
    }
  }

  const retLines = [];
  for (let startOff = 0; startOff < buffer.length; startOff += rowWidth) {
    const curChunk = buffer.subarray(startOff, startOff + rowWidth);
    retLines.push(
      startOff.toString(16).padStart(8, '0') + ': ' +
      curChunk.toString('hex').split(xxdSplitter).filter(x => x.length).join(' ').padEnd(rowWidth * 2 + ((rowWidth / 2) + 1)) + ' ' +
      curChunk.toString().replace(unprintables, '.')
    );
  }

  return returnRawLines ? retLines : retLines.join('\n');
}

module.exports = { xxd };
