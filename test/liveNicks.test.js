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

test('LiveNicks merge', () => {
  const l1 = new LiveNicks(['l1_a','l1_b','l1_c','l1_d','l1_e']);
  l1.swap('l1_a', 'l1_aa');
  l1.swap('l1_aa', 'l1_aaa');
  l1.swap('l1_aaa', 'l1_aaaa');

  expect(l1.get('l1_aaaa').history())
    .toEqual(['l1_aaaa', 'l1_aaa', 'l1_aa', 'l1_a']);

  const l2 = new LiveNicks(['l1_aaaa','l1_b','l1_c','l1_d','l1_e'], l1);
  expect(l2.get('l1_aaaa').history())
    .toEqual(['l1_aaaa', 'l1_aaa', 'l1_aa', 'l1_a']);
    
  l2.swap('l1_d', 'l1_dd');
  l2.swap('l1_dd', 'l1_ddd');
  l2.swap('l1_ddd', 'l1_dddd');
  expect(l2.get('l1_dddd').history())
    .toEqual(['l1_dddd', 'l1_ddd', 'l1_dd', 'l1_d']);

  const l3 = new LiveNicks(['l1_aaaa', 'l1_dddd'], l2);
  expect(l3.get('l1_aaaa').history())
    .toEqual(['l1_aaaa', 'l1_aaa', 'l1_aa', 'l1_a']);
  expect(l3.get('l1_dddd').history())
    .toEqual(['l1_dddd', 'l1_ddd', 'l1_dd', 'l1_d']);

  // should have no effect (idempotent)
  l3.add('l1_dddd');
  expect(l3.get('l1_dddd').history())
    .toEqual(['l1_dddd', 'l1_ddd', 'l1_dd', 'l1_d']);
})