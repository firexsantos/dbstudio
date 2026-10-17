// Small, dependency-free SQL formatter. Keeps strings/comments intact, uppercases keywords,
// breaks major clauses onto new lines and indents select lists, conditions and subqueries.
const KEYWORDS = new Set(
  `select from where and or not in is null like between exists group by order having limit offset join inner left right full outer cross on as
   insert into values update set delete create table alter drop add column primary key foreign references index unique distinct union all
   case when then else end asc desc with recursive returning default constraint view if replace truncate cascade restrict check over partition
   window rows range unbounded preceding following current row ilike similar natural using lateral fetch first next only true false
   begin commit rollback transaction show describe explain analyze`.split(/\s+/),
);
const NEWLINE_BEFORE = [
  'select', 'from', 'where', 'group by', 'order by', 'having', 'limit', 'offset', 'union', 'union all', 'values', 'set',
  'insert into', 'update', 'delete from', 'returning', 'window', 'inner join', 'left join', 'right join', 'full join',
  'left outer join', 'right outer join', 'full outer join', 'cross join', 'join', 'on conflict', 'with',
];

function tokenize(sql) {
  const out = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const rest = sql.slice(i);
    let m;
    if ((m = /^\s+/.exec(rest))) out.push({ t: 'ws', v: m[0] });
    else if ((m = /^--[^\n]*/.exec(rest)) || (m = /^\/\*[\s\S]*?\*\//.exec(rest))) out.push({ t: 'comment', v: m[0] });
    else if ((m = /^'(?:[^'\\]|\\.|'')*'/.exec(rest)) || (m = /^"(?:[^"]|"")*"/.exec(rest)) || (m = /^`(?:[^`]|``)*`/.exec(rest))) out.push({ t: 'str', v: m[0] });
    else if ((m = /^\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/.exec(rest))) out.push({ t: 'str', v: m[0] });
    else if ((m = /^[A-Za-z_][\w$]*/.exec(rest))) out.push({ t: 'word', v: m[0] });
    else if ((m = /^\d+(\.\d+)?/.exec(rest))) out.push({ t: 'num', v: m[0] });
    else if ((m = /^(<=|>=|<>|!=|::|\|\||->>|->)/.exec(rest))) out.push({ t: 'op', v: m[0] });
    else out.push({ t: 'punct', v: ch }), (m = [ch]);
    i += m[0].length;
  }
  return out;
}

export function formatSQL(sql) {
  const statements = [];
  let buf = [];
  for (const tok of tokenize(sql)) {
    if (tok.t === 'punct' && tok.v === ';') {
      statements.push(buf);
      buf = [];
    } else buf.push(tok);
  }
  if (buf.some((t) => t.t !== 'ws')) statements.push(buf);
  return statements.map(formatOne).filter(Boolean).join(';\n\n') + (statements.length ? ';' : '');
}

function formatOne(tokens) {
  const toks = tokens.filter((t) => t.t !== 'ws');
  if (!toks.length) return '';
  let out = '';
  let depth = 0;
  const parenStack = [];
  let clause = '';
  const indent = (n) => '  '.repeat(Math.max(0, n));
  const nl = (extra = 0) => {
    out = out.replace(/[ \t]+$/, '');
    out += '\n' + indent(depth + extra);
  };
  const lower = (t) => (t.t === 'word' ? t.v.toLowerCase() : '');

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const w = lower(t);
    // multi-word clause lookahead
    let phrase = null;
    for (const p of NEWLINE_BEFORE.slice().sort((a, b) => b.length - a.length)) {
      const parts = p.split(' ');
      if (parts.every((pp, k) => lower(toks[i + k] || {}) === pp)) {
        phrase = parts;
        break;
      }
    }
    if (phrase) {
      if (out.trim()) nl();
      out += phrase.join(' ').toUpperCase();
      clause = phrase.join(' ');
      i += phrase.length - 1;
      if (['select', 'set', 'group by', 'order by', 'values'].includes(clause)) nl(1);
      else out += ' ';
      continue;
    }
    if (t.t === 'comment') {
      out += t.v;
      if (t.v.startsWith('--')) nl();
      else out += ' ';
      continue;
    }
    if (t.t === 'punct' && t.v === '(') {
      const isSub = lower(toks[i + 1] || {}) === 'select';
      parenStack.push({ isSub, clause });
      const prev = toks[i - 1];
      const isCall = !isSub && clause !== 'insert into' && prev && ((prev.t === 'word' && !KEYWORDS.has(lower(prev))) || prev.t === 'str');
      if (isCall) out = out.replace(/ $/, '');
      out += '(';
      if (isSub) depth += 2;
      continue;
    }
    if (t.t === 'punct' && t.v === ')') {
      const p = parenStack.pop();
      out = out.replace(/ $/, '');
      if (p?.isSub) {
        depth -= 2;
        nl(1);
        clause = p.clause;
      }
      out += ') ';
      continue;
    }
    if (t.t === 'punct' && t.v === ',') {
      out = out.replace(/ $/, '');
      out += ',';
      if (!parenStack.length || parenStack.at(-1).isSub) {
        if (['select', 'set', 'group by', 'order by'].includes(clause)) nl(1);
        else if (clause === 'values') nl(1);
        else out += ' ';
      } else out += ' ';
      continue;
    }
    if ((w === 'and' || w === 'or') && ['where', 'having', 'on', 'join', 'left join', 'inner join'].includes(clause) && (!parenStack.length || parenStack.at(-1).isSub)) {
      nl(1);
      out += w.toUpperCase() + ' ';
      continue;
    }
    if (t.t === 'punct' && t.v === '.') {
      out = out.replace(/ $/, '') + '.';
      continue;
    }
    let v = t.v;
    if (t.t === 'word' && KEYWORDS.has(w) && lower(toks[i - 1] || {}) !== '.' && !(toks[i - 1]?.v === '.')) v = v.toUpperCase();
    out += v;
    const next = toks[i + 1];
    if (next && !(next.t === 'punct' && (next.v === '.' || next.v === ',' || next.v === ')')) && !(t.t === 'op' && t.v === '::') && !(next.t === 'op' && next.v === '::')) out += ' ';
  }
  return out.trim().replace(/\n{3,}/g, '\n\n');
}
