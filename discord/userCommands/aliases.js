'use strict';

const config = require('../../config');
const { manageAliases } = require('../lib/ucAliases');

async function aliases (context) {
  return manageAliases(context.options);
}

const pfxChar = config.app.allowedSpeakersCommandPrefixCharacter;
aliases.__drcHelp = () => {
  return {
    title: 'Manage user command aliases',
    usage: '[aliasName] [aliasValue]',
    notes: '`aliasName` may be a normal string, which must match exactly, or a regular expression (details below). They are invoked in the same ' +
      'way as standard user commands and are checked for matches _before_ normal user commands. Any arguments in an alias invocation ' +
      'will be appended to the defined `aliasValue`.\n\n' +
      'Usage is contextual:\n\n' +
      '• with no arguments, will print all the current aliases _or_ clear them all with `--clearAll`.\n\n' +
      '• one argument - `aliasName` - will retrieve the value of `aliasName` _or_ remove it if passed `--remove`.\n\n' +
      '• two arguments - `aliasName` "`aliasValue`" - will set `aliasName` to `aliasValue`.\n\n' +
      'If `aliasValue` contains command-line options, it should be surrounded by quotes to ensure they are not considered part ' +
      'of the `alias` invocation.\n\n' +
      'The regex variant must have `aliasName` bounded by forward slashes - `/.../` - to be recognized as a regex pattern. ' +
      'When a regex is used, any groups captured ' +
      'can be referenced in `aliasValue` with the `$N` syntax where `N` is the group index starting at 1. Regex aliases are checked ' +
      'before normal string aliases, so take care that they are not overly-broad and would inadvertantly match before valid normal-string ' +
      'aliases you have defined.\n\n' +
      'For example, an alias created like so:\n\n`' +
      pfxChar + 'aliases /sl(\\w*?)(\\d+)/ "logs libera --from=-$2m --$1"`\n\n' +
      'and invoked like so: `' + pfxChar + 'slnick60 EdFletcher`\n\n' +
      'would expand to: `' + pfxChar + 'logs libera --from=-60m --nick EdFletcher`\n\n',
    options: [
      ['--remove', 'Removes `aliasName` (only valid in one-argument context)'],
      ['--clearAll', 'Removes all aliases (only valid in no-argument context).']
    ]
  };
};

module.exports = aliases;
