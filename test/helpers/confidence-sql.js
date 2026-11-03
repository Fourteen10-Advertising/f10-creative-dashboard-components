'use strict';
/* Test helper: evaluate the scatter SQL's per-ad verdict the way BigQuery
 * would, so fixtures carry the verdict column the dashboard reads. The verdict
 * is single-sourced in SQL; tests run that SQL rather than re-deriving it. */

/* Evaluate an emitted BigQuery verdict expression as JS. A SQL NULL is JS
 * null; an out-of-range SAFE_OFFSET is JS undefined, which IFNULL also treats
 * as NULL. */
function evalVerdictSQL(sql, vars){
  const isNull = (x) => x === null || x === undefined || (typeof x === 'number' && Number.isNaN(x));
  const fns = {
    IF: (c, a, b) => (c === true ? a : b),
    IFNULL: (x, d) => (isNull(x) ? d : x),
    SAFE_DIVIDE: (a, b) => (isNull(a) || isNull(b) || b === 0 ? null : a / b),
    GREATEST: (a, b) => (isNull(a) || isNull(b) ? null : Math.max(a, b)),
    FLOOR: (x) => (isNull(x) ? null : Math.floor(x)),
    SQRT: (x) => (isNull(x) ? null : Math.sqrt(x)),
    POW: (x, y) => (isNull(x) || isNull(y) ? null : Math.pow(x, y)),
    CAST_INT64: (x) => (isNull(x) ? null : Math.trunc(x)),
    SAFE_OFFSET: (i) => i,
    FALSE: false,
  };
  const js = sql.replace(/CAST\(/g, 'CAST_INT64(').replace(/ AS INT64\)/g, ')');
  const names = Object.keys(fns).concat(Object.keys(vars));
  const vals = names.map((n) => (n in fns ? fns[n] : vars[n]));
  return Function.apply(null, names.concat(['"use strict"; return (' + js + ');'])).apply(null, vals);
}

const unq = (s) => s.replace(/\\'/g, "'").replace(/\\\\/g, '\\');

/* Parse a target CASE into [{group, segment, value}]. */
function parseTargetCase(expr){
  const out = [];
  if (/^CAST\(NULL AS FLOAT64\)$/.test(expr.trim())) return out;
  const re = /WHEN IFNULL\(conf_group, ''\) = '((?:[^'\\]|\\.)*)' AND conf_segment = '((?:[^'\\]|\\.)*)' THEN ([-0-9.eE+]+)/g;
  let m;
  while ((m = re.exec(expr))) out.push({ group: unq(m[1]), segment: unq(m[2]), value: Number(m[3]) });
  return out;
}
function lookup(cases, r){
  const g = r.conf_group == null ? '' : String(r.conf_group);
  const hit = cases.find((c) => c.group === g && c.segment === r.conf_segment);
  return hit ? hit.value : null;
}

/* Parse the per_ad_conf CTE and the verdict select out of the scatter SQL. */
function parseScatterVerdictSQL(sql){
  const cte = sql.indexOf('per_ad_conf AS (');
  if (cte < 0) return null;
  const a = sql.indexOf('SELECT *, ', cte) + 'SELECT *, '.length;
  const b = sql.indexOf(' AS kill_target, ', a);
  const c = sql.indexOf(' AS scale_target', b);
  const killCase = sql.slice(a, b);
  const scaleCase = sql.slice(b + ' AS kill_target, '.length, c);
  const vEnd = sql.indexOf(' AS verdict');
  const vStart = sql.lastIndexOf('IF(kill_target IS NULL AND scale_target IS NULL', vEnd);
  const verdict = sql.slice(vStart, vEnd);
  return { kill: parseTargetCase(killCase), scale: parseTargetCase(scaleCase), verdict };
}

/* Return copies of rows with kill_target, scale_target and verdict as the
 * scatter SQL would compute them. Rows pass through untouched when the SQL has
 * no verdict (no CONFIDENCE_LINES config). */
function withSqlVerdicts(sql, rows){
  const p = parseScatterVerdictSQL(sql);
  if (!p) return rows;
  const js = p.verdict
    .replace('kill_target IS NULL AND scale_target IS NULL', '(kill_target === null && scale_target === null)')
    .replace('CAST(NULL AS STRING)', 'null');
  return rows.map((r) => {
    const kill_target = lookup(p.kill, r);
    const scale_target = lookup(p.scale, r);
    const verdict = evalVerdictSQL(js, {
      lifetime_spend: r.lifetime_spend == null ? null : Number(r.lifetime_spend),
      kill_conv: r.kill_conv == null ? null : Number(r.kill_conv),
      scale_conv: r.scale_conv == null ? null : Number(r.scale_conv),
      kill_target, scale_target,
    });
    return Object.assign({}, r, { kill_target, scale_target, verdict });
  });
}

module.exports = { evalVerdictSQL, parseTargetCase, parseScatterVerdictSQL, withSqlVerdicts };
