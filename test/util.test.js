const util = require('../util')

test('resolveNameForIRC', () => {
  expect(util.resolveNameForIRC('irc.libera.chat', 'chat')).toEqual('#chat')
  expect(util.resolveNameForIRC('irc.libera.chat', 'cpp')).toEqual('c++')
  expect(util.resolveNameForIRC('irc.libera.chat', 'cppgeneral')).toEqual('c++-general')
  expect(util.resolveNameForIRC('irc.libera.chat', 'infra-talk')).toEqual('#infra-talk')
  expect(util.resolveNameForIRC('irc.libera.chat', 'nodejs')).toEqual('node.js')
})

test('resolveNameForDiscord', () => {
  expect(util.resolveNameForDiscord('irc.libera.chat', '#chat')).toEqual('chat')
  expect(util.resolveNameForDiscord('irc.libera.chat', '#c++')).toEqual('cpp')
  expect(util.resolveNameForDiscord('irc.libera.chat', '#c++-general')).toEqual('cppgeneral')
  expect(util.resolveNameForDiscord('irc.libera.chat', '##infra-talk')).toEqual('infra-talk')
  expect(util.resolveNameForDiscord('irc.libera.chat', '#node.js')).toEqual('nodejs')
})

test('matchNetwork', () => {
  expect(util.matchNetwork('foo').network).toEqual('foo.bar.irc')
  expect(util.matchNetwork('irc.f').network).toEqual('irc.foo.bar')

  expect(() => {
    util.matchNetwork('i')
  }).toThrowError(util.AmbiguousMatchResultError)

  expect(() => {
    util.matchNetwork('thisNetworkDoesntExist')
  }).toThrowError(util.NetworkNotMatchedError)
})
