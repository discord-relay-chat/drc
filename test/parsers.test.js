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
  expect(parsers.parseArgsForQuotes(
    parsers.parseCommandAndArgs('!logs libera --from="Fri Jan 13 2023"').args
  )).toEqual(['libera', '--from="Fri Jan 13 2023"']);

  expect(parsers.parseArgsForQuotes(
    parsers.parseCommandAndArgs('!tryParseDate "Fri Jan 13 2023"').args
  )).toEqual(['"Fri Jan 13 2023"']);
});