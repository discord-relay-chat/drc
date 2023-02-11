'use strict';

module.exports = {
  queryBuilder (options, fromTime, toTime) {
    const params = [];
    const logicOp = (options.or || options.ored) ? 'OR' : 'AND';
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

    let query = [
      [options.message, `message ${stringComp}`],
      [options.nick, `nick ${stringComp}`],
      [options.channel, `target ${stringComp}`],
      [options.target, `target ${stringComp}`],
      [options.host, `hostname ${stringComp}`],
      [options.hostname, `hostname ${stringComp}`],
      [options.ident, `ident ${stringComp}`],
      [options.type, 'type ='],
      [fromTime, '__drcIrcRxTs >='],
      [toTime, '__drcIrcRxTs <=']
    ].reduce((q, [val, clause]) => {
      if (val) {
        params.push(val);
        return `${q}${params.length - 1 ? ` ${logicOp}` : ' WHERE'} ${clause} ?`;
      }

      return q;
    }, `SELECT ${selectClause} FROM channel`);

    if (options.from_server) {
      query += `${params.length ? ` ${logicOp}` : ' WHERE'} from_server = 1`;
    }

    return [query, params];
  }
};
