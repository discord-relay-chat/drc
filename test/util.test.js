global.AbortSignal = {};

process.env.NODE_ENV = 'test';

const path = require('path');
const util = require('../util');

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
});

test('Mapper', async () => {
  const tmPath = path.join(__dirname, 'test.Mapper.json');
  const tm = new util.Mapper(tmPath,  'TEST');
  
  try {
    await tm.forNetwork('test.network');
    expect(false).toEqual(true);
  } catch {
    expect(true).toEqual(true);
  }

  await tm.init();

  const curNet = await tm.forNetwork('test.network');
  expect(curNet.oldKey).toEqual('#oldValue');
  expect(curNet.foo).toEqual('#bar');

  await tm.set('test.network', 'baz', '42');
  expect(await tm.get('test.network', 'baz')).toEqual('42');

  await tm.set('another.test.network', 'foo', 'baz');
  expect((await tm.forNetwork('another.test.network')).foo).toEqual('baz');

  const all = await tm.all();
  expect(all).toEqual({
    'another.test.network': { foo: 'baz' },
    'test.network': { oldKey: '#oldValue', foo: '#bar', baz: '42' }
  });

  await tm.set('test.network', 'anObject', { foo: 42 });
  expect(await tm.get('test.network', 'anObject')).toEqual({ foo: 42 });

  expect(await tm.findNetworkForKey('oldKey')).toEqual('test.network');
});