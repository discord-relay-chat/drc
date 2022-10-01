module.exports = async function (context, args, ...a) {
  console.log('topic!');
  console.log(context);
  console.log(args);
  console.log(...a);
};
