global.AbortSignal = {};

const LiveNicks = require('../irc/liveNicks');

test('LiveNicks', () => {
  const l = new LiveNicks();
  expect(l.has('foo')).toEqual(false);

  expect(l.add('foo')).toEqual(true);
  expect(l.has('foo')).toEqual(true);

  expect(l.swap('foo', 'f00')).toEqual(true);
  expect(l.get('f00').current).toEqual('f00');
  expect(l.get('f00').history()).toEqual(['f00', 'foo']);

  expect(l.add('bar')).toEqual(true);
  expect(l.add('baz')).toEqual(true);
  expect(l.has('bar')).toEqual(true);
  expect(l.has('baz')).toEqual(true);
  expect(l.size()).toEqual(3);

  expect(l.swap('f00', 'foober')).toEqual(true);
  expect(l.swap('foober', 'barbaz')).toEqual(true);
  expect(l.has('foo')).toEqual(false);
  expect(l.has('f00')).toEqual(false);
  expect(l.has('foober')).toEqual(false);
  expect(l.has('barbaz')).toEqual(true);
  expect(l.get('barbaz').current).toEqual('barbaz');
  expect(l.get('barbaz').history()).toEqual(['barbaz', 'foober', 'f00', 'foo']);

  expect(l.had('foo')).toEqual(['barbaz']);
  expect(l.had('f00')).toEqual(['barbaz']);
  expect(l.had('foober')).toEqual(['barbaz']);

  expect(l.delete('bar')).toEqual(true);
  expect(l.size()).toEqual(2);
  expect(l.has('bar')).toEqual(false);
  expect(l.has('barbaz')).toEqual(true);
  expect(l.has('baz')).toEqual(true);

  expect(l.delete('bar')).toEqual(false);
  expect(l.get('bar')).toEqual(undefined);

  expect(l.delete('baz')).toEqual(true);
  expect(l.size()).toEqual(1);
  expect(l.delete('barbaz')).toEqual(true);
  expect(l.size()).toEqual(0);
  expect(l.delete('barbaz')).toEqual(false);
  expect(l.size()).toEqual(0);
});

test('LiveNicks starting with existing', () => {
  const l = new LiveNicks(['foo', 'bar', 'baz']);
  expect(l.has('foo')).toEqual(true);
  expect(l.add('foo')).toEqual(false);
  expect(l.delete('foo')).toEqual(true);

  expect(l.swap('bar', 'bargh')).toEqual(true);
  expect(l.had('bar')).toEqual(['bargh']);
});

test('LiveNicks internal interfaces', () => {
  const l = new LiveNicks();
  expect(l.add('bar')).toEqual(true);
  expect(l.get('bar').add('bar')).toEqual(false);
});

test('LiveNicks corner cases', () => {
  const l = new LiveNicks();
  expect(l.swap('DNEnick', 'newNick')).toEqual(false);
});