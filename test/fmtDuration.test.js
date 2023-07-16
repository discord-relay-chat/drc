global.AbortSignal = {};

const { tryToParseADateOrDuration } = require('../lib/fmtDuration');

test('FmtDuration', () => {
    const uts = tryToParseADateOrDuration(1681489631292);
    expect(uts.toISOString()).toEqual('2023-04-14T16:27:11.292Z');

    const strd = tryToParseADateOrDuration('');
    expect(strd).toEqual(undefined);
});