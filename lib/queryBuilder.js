'use strict';

module.exports = {
  queryBuilder (options, fromTime, toTime) {
    const params = [];
    const columns = options.columns || '*';
    const distinct = options.distinct ? 'DISTINCT ' : '';
    const stringComp = options.strictStrings === true ? '=' : 'LIKE';
    let selectClause = `${distinct}${columns}`;
    if (options.max) {
      selectClause = `MAX(${options.max})`;
    }

    if (options.min) {
      selectClause = `MIN(${options.min})`;
    }

    options = { ...options, fromTime, toTime };

    const valAdder = (innerLogicOp, q, [valName, clause]) => {
      const val = options[valName];
      if (val) {
        const addClauseToQuery = (clauseParam) => {
          params.push(clauseParam);
          return `${params.length - 1 ? ` ${innerLogicOp}` : ` WHERE ${innerLogicOp === 'OR' ? '(' : ''}`} ${clause} ?`;
        };

        if (Array.isArray(val)) {
          return q + val.map(addClauseToQuery).join(' ');
        } else if (typeof (val) === 'object' && !(val instanceof Date)) {
          throw new Error('can\'t use object here!', val);
        }

        return q + addClauseToQuery(val);
      }

      return q;
    };

    let orTuples = [];
    let andTuples = [
      ['message', `message ${stringComp}`],
      ['nick', `nick ${stringComp}`],
      ['channel', `target ${stringComp}`],
      ['target', `target ${stringComp}`],
      ['host', `hostname ${stringComp}`],
      ['hostname', `hostname ${stringComp}`],
      ['ident', `ident ${stringComp}`],
      ['type', 'type ='],
      ['fromTime', '__drcIrcRxTs >='],
      ['toTime', '__drcIrcRxTs <='],
      ['from_server', 'from_server = 1']
    ];

    if (options.orKeys) {
      const orKeys = options.orKeys.split(',').map(s => s.trim());
      orTuples = andTuples.filter(([key]) => orKeys.indexOf(key) !== -1);
      andTuples = andTuples.filter(([key]) => orKeys.indexOf(key) === -1);
    }

    let query = `SELECT ${selectClause} FROM channel`;

    if (orTuples.length) {
      query = orTuples.reduce(valAdder.bind(null, 'OR'), query) + ')';
    }

    query = andTuples.reduce(valAdder.bind(null, 'AND'), query);
    return [query, params];
  }
};
