module.exports = function (textToChunk, maxChunkLengthInChars = 2000, chunker = ' ') {
  return textToChunk
    .split(chunker)
    .reduce((listOfChunks, chunkToken) => {
      let curChunk = listOfChunks.pop();
      if (curChunk.length + chunker.length + chunkToken.length > maxChunkLengthInChars) {
        listOfChunks.push(curChunk);
        curChunk = '';
      }
      curChunk += chunkToken + chunker;
      return [...listOfChunks, curChunk];
    }, ['']);
};
