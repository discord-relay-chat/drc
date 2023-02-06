global.AbortSignal = {};

const parsers = require('../lib/parsers');

process.env.NODE_ENV = 'test';

test('parseMessageStringForPipes', async () => {
  let runFunc = parsers.parseMessageStringForPipes(
    '|> oneA !> oneB !> oneC !> oneD |> twoA !> twoB !> twoC |> three |> four |> 5a !> 5b');

  expect(await runFunc()).toEqual(
    [
      [ 'oneA', 'oneB', 'oneC', 'oneD' ],
      [ 'twoA', 'twoB', 'twoC' ],
      [ 'three' ],
      [ 'four' ],
      [ '5a', '5b' ]
    ]
  );
});

test('parseArgsForQuotes', async () => {
  const testOpts = {
    autoPrefixCurrentCommandChar: true
  };

  expect(parsers.parseArgsForQuotes(
    parsers.parseCommandAndArgs('logs libera --from="Fri Jan 13 2023"', testOpts).args
  )).toEqual(['libera', '--from="Fri Jan 13 2023"']);

  expect(parsers.parseArgsForQuotes(
    parsers.parseCommandAndArgs('tryParseDate "Fri Jan 13 2023"', testOpts).args
  )).toEqual(['"Fri Jan 13 2023"']);
});

test('parseCommandAndArgs', async () => {
  const expectedShape = {
    command: 'd',
    args: ['l', '10']
  };

  expect(parsers.parseCommandAndArgs(';d l 10')).toEqual(expectedShape);
  expect(parsers.parseCommandAndArgs('   ;d l 10')).toEqual(expectedShape);
  expect(parsers.parseCommandAndArgs(';   d l 10')).toEqual(expectedShape);
  expect(parsers.parseCommandAndArgs('  ;   d l 10')).toEqual(expectedShape);
  expect(parsers.parseCommandAndArgs('  ;   d    l      10    ')).toEqual(expectedShape);

  expect(parsers.parseCommandAndArgs.bind(null, 'd l 10')).toThrow();
  expect(parsers.parseCommandAndArgs.bind(null, ';d l 10', { autoPrefixCurrentCommandChar: true })).toThrow();
});