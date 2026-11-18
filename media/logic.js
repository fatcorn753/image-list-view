// 絞り込みと並べ替えの純粋関数。Webview と Node のテストの両方から読み込む。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.ImageListLogic = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const WILDCARD = /[*?{]/;

  // `**` `*` `?` `{a,b}` だけを扱う最小限の glob。macOS のファイル名は大文字小文字を区別しないことが多いので i を付ける。
  function globToRegExp(pattern) {
    let re = '';
    let inBrace = false;
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === '*') {
        if (pattern[i + 1] === '*') {
          if (pattern[i + 2] === '/') {
            re += '(?:.*/)?';
            i += 2;
          } else {
            re += '.*';
            i += 1;
          }
        } else {
          re += '[^/]*';
        }
      } else if (c === '?') {
        re += '[^/]';
      } else if (c === '{') {
        inBrace = true;
        re += '(?:';
      } else if (c === '}' && inBrace) {
        inBrace = false;
        re += ')';
      } else if (c === ',' && inBrace) {
        re += '|';
      } else {
        re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
      }
    }
    if (inBrace) {
      re += ')';
    }
    return new RegExp('^' + re + '$', 'i');
  }

  // ワイルドカードを含まない入力は部分一致として扱う(「loss」と打つだけで絞れるように)。
  // `/` を含まないパターンはファイル名だけ、含むパターンは起点フォルダからの相対パスと照合する。
  function makeMatcher(pattern) {
    const p = (pattern || '').trim();
    if (!p) {
      return () => true;
    }
    if (!WILDCARD.test(p)) {
      const needle = p.toLowerCase();
      const usePath = p.includes('/');
      return (item) => (usePath ? item.rel : item.name).toLowerCase().includes(needle);
    }
    const re = globToRegExp(p);
    const usePath = p.includes('/');
    return (item) => re.test(usePath ? item.rel : item.name);
  }

  function filterItems(items, pattern) {
    const match = makeMatcher(pattern);
    return items.filter(match);
  }

  // 「…_run2」と「…_run10」が数値順に並ぶよう numeric 比較にする。
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  const SORT_KEYS = ['name', 'mtime', 'ctime', 'size'];

  function sortItems(items, key, dir) {
    const sign = dir === 'desc' ? -1 : 1;
    const byName = (a, b) => collator.compare(a.rel, b.rel);
    const cmp =
      key === 'name' || !SORT_KEYS.includes(key)
        ? byName
        : (a, b) => (a[key] - b[key]) || byName(a, b);
    return items.slice().sort((a, b) => sign * cmp(a, b));
  }

  return { globToRegExp, makeMatcher, filterItems, sortItems, SORT_KEYS };
});
