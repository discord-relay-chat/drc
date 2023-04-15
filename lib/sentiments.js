const Sentiment = require('sentiment');
const { SentimentAnalyzer } = require('node-nlp');

const analyzer = new Sentiment();
const nlpAnalyzer = new SentimentAnalyzer();

async function attachSentimentToMessages (channel, messageList, a, options = {}) {
  if (!a || !a.perChan || !a.perNick) {
    a = {
      perNick: {},
      perChan: {}
    };
  }

  for (const msgObj of messageList) {
    let analyzed;
    if (options.useNodeNlp) {
      analyzed = await nlpAnalyzer.getSentiment(msgObj.message);
      analyzed.comparative = analyzed.average;
    } else {
      analyzed = analyzer.analyze(msgObj.message);
    }
    const { score, comparative } = analyzed;
    msgObj.sentiment = { score, comparative };
    if (!a.perNick[msgObj.nick]) {
      a.perNick[msgObj.nick] = [];
    }
    const tuple = [msgObj.sentiment.score, msgObj.sentiment.comparative];
    a.perNick[msgObj.nick].push(tuple);
    if (!channel && msgObj.target) {
      channel = msgObj.target;
    }
    if (channel) {
      if (!a.perChan[channel]) {
        a.perChan[channel] = [];
      }
      a.perChan[channel].push(tuple);
    }
  }

  return a;
}

function averageSentiments (sentimentsPer) {
  if (!sentimentsPer) {
    return {};
  }

  return Object.entries(sentimentsPer)
    .reduce((b, [perKey, perObj]) => ({
      [perKey]: Object.fromEntries(Object.entries(perObj)
        .reduce((c, [thing, sentimentList]) => {
          const [score, comparative] = sentimentList
            .reduce(([aScore, aComp], [score, comp]) => ([aScore + score, aComp + comp]), [0, 0])
            .map((v) => v / sentimentList.length);
          return [...c, [
            thing,
            { score, comparative, count: sentimentList.length }
          ]];
        }, [])),
      ...b
    }), {});
}

function sentimentMapper ([k, v]) {
  return {
    key: k,
    value: {
      ...v,
      score: Number(v.score).toFixed(1),
      scoreRound: Math.round(v.score),
      comparative: Number(v.comparative).toFixed(3),
      comparativeRound: Math.round(v.comparative)
    }
  };
}

function transformAveragesForDigestHTTP (sentiments, options = {}) {
  let sentimentSorter = ([, oA], [, oB]) => oB.comparative - oA.comparative;
  if (options.sortByScore) {
    sentimentSorter = ([, oA], [, oB]) => oB.score - oA.score;
  }
  if (options.sortByCount) {
    sentimentSorter = ([, oA], [, oB]) => oB.count - oA.count;
  }
  if (options.sortByName) {
    sentimentSorter = ([kA], [kB]) => kA.localeCompare(kB);
  }

  return Object.entries(sentiments)
    .reduce((a, [k, vals]) => ({
      [k]: Object.entries(vals)
        .sort(sentimentSorter)
        .map(sentimentMapper),
      ...a
    }), {});
}

function roundSentimentScoreOnMessages (messageList) {
  messageList.forEach((msgObj) => (msgObj.sentiment = sentimentMapper([null, msgObj.sentiment]).value));
}

module.exports = {
  attachSentimentToMessages,
  averageSentiments,
  transformAveragesForDigestHTTP,
  roundSentimentScoreOnMessages
};
