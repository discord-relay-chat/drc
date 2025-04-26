async function topic (context, args, ...a) {
  console.log('topic!');
  console.log(context);
  console.log(args);
  console.log(...a);
}

topic.__drcHelp = () => ({
  title: 'Manage IRC channel topics',
  usage: '[topic_text]',
  notes: 'View or set the topic for the current IRC channel. If no text is provided, displays the current topic.'
});

module.exports = topic;
