const util = require('../util');

process.env.NODE_ENV = 'test';

test('resolveNameForIRC', () => {
  expect(util.resolveNameForIRC('irc.libera.chat', 'chat')).toEqual('#chat');
  expect(util.resolveNameForIRC('irc.libera.chat', 'cpp')).toEqual('c++');
  expect(util.resolveNameForIRC('irc.libera.chat', 'cppgeneral')).toEqual('c++-general');
  expect(util.resolveNameForIRC('irc.libera.chat', 'infra-talk')).toEqual('#infra-talk');
  expect(util.resolveNameForIRC('irc.libera.chat', 'nodejs')).toEqual('node.js');
});

test('resolveNameForDiscord', () => {
  expect(util.resolveNameForDiscord('irc.libera.chat', '#chat')).toEqual('chat');
  expect(util.resolveNameForDiscord('irc.libera.chat', '#c++')).toEqual('cpp');
  expect(util.resolveNameForDiscord('irc.libera.chat', '#c++-general')).toEqual('cppgeneral');
  expect(util.resolveNameForDiscord('irc.libera.chat', '##infra-talk')).toEqual('infra-talk');
  expect(util.resolveNameForDiscord('irc.libera.chat', '#node.js')).toEqual('nodejs');
});

test('matchNetwork', () => {
  expect(util.matchNetwork('foo').network).toEqual('foo.bar.irc');
  expect(util.matchNetwork('irc.f').network).toEqual('irc.foo.bar');

  expect(() => {
    util.matchNetwork('i');
  }).toThrowError(util.AmbiguousMatchResultError);

  expect(() => {
    util.matchNetwork('thisNetworkDoesntExist');
  }).toThrowError(util.NetworkNotMatchedError);
});

test('replaceIrcEscapes', () => {
  expect(util.replaceIrcEscapes('\x1funderline me!\x1f \x02bold!\x02'))
    .toEqual('__underline me!__ **bold!**');
  expect(util.replaceIrcEscapes('\x1ditalics\x1d \x1estrikeout\x1e \x11monospace\x11'))
    .toEqual('_italics_ ~strikeout~ `monospace`');

  expect(util.replaceIrcEscapes('\x16\x0f')).toEqual('');

  expect(util.replaceIrcEscapes(Buffer.from(Array.from({ length: util.IRCColorsStripMax }).map((_, i) => i)).toString().split('').map(x => `\x03${x}`).join(''))).toEqual('');

  expect(util.replaceIrcEscapes('`IRC:JOINED-CHANNEL` **#irpg** (#irpg) on `irc.undernet.org` has **77** users'))
    .toEqual('`IRC:JOINED-CHANNEL` **#irpg** (#irpg) on `irc.undernet.org` has **77** users');

  expect(util.replaceIrcEscapes(Buffer.from('02 5b 72 69 7a 6f 6e 5d 02 20 3c 2b 03 30 35 44 75 63 6b 48 75 6e 74 03 3e'.split(' ').join(''), 'hex').toString()))
    .toEqual('**[rizon]** <+DuckHunt>');

  expect(util.replaceIrcEscapes('\x02[rizon]\x02 <\x0309cpucake_13\x03>')).toEqual('**[rizon]** <cpucake_13>');
})

test('isObjPathExtant', () => {
  const x = {
    foo: {
      bar: {
        baz: 42
      }
    },
    buz: {
      bit: []
    }
  };

  expect({
    bar: {
      baz: 42
    }
  }).toEqual(util.isObjPathExtant(x, ['foo']))
  expect(null).toEqual(util.isObjPathExtant(x, ['foo', 'baz']))
  expect({
    baz: 42
  }).toEqual(util.isObjPathExtant(x, ['foo', 'bar']))
  expect(42).toEqual(util.isObjPathExtant(x, ['foo', 'bar', 'baz']))
})