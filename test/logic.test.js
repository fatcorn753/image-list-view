const test = require('node:test');
const assert = require('node:assert/strict');
const { filterItems, sortItems, globToRegExp } = require('../media/logic.js');

const item = (rel, mtime = 0, ctime = 0, size = 0) => ({
  id: rel,
  rel,
  name: rel.split('/').pop(),
  mtime,
  ctime,
  size,
});

const items = [
  item('exp_lr001_run10_loss.png', 30, 3, 500),
  item('exp_lr001_run2_loss.png', 10, 1, 300),
  item('exp_lr003_run2_loss.png', 20, 2, 300),
  item('sub/Other.PNG', 40, 4, 100),
  item('memo.jpg', 5, 9, 900),
];
const rels = (list) => list.map((i) => i.rel);

test('空のパターンは全件', () => {
  assert.equal(filterItems(items, '').length, 5);
  assert.equal(filterItems(items, '   ').length, 5);
});

test('ワイルドカードなしは大文字小文字を無視した部分一致', () => {
  assert.deepEqual(rels(filterItems(items, 'LR001')), [
    'exp_lr001_run10_loss.png',
    'exp_lr001_run2_loss.png',
  ]);
});

test('glob はファイル名と照合する', () => {
  assert.deepEqual(rels(filterItems(items, 'exp_*_run?_*.png')), [
    'exp_lr001_run2_loss.png',
    'exp_lr003_run2_loss.png',
  ]);
  assert.equal(filterItems(items, '*.{jpg,PNG}').length, 5);
  assert.deepEqual(rels(filterItems(items, '*.jpg')), ['memo.jpg']);
});

test('/ を含む glob は相対パスと照合する', () => {
  assert.deepEqual(rels(filterItems(items, 'sub/*')), ['sub/Other.PNG']);
  assert.deepEqual(rels(filterItems(items, '**/other.png')), ['sub/Other.PNG']);
  assert.equal(filterItems(items, '*/memo.jpg').length, 0);
});

test('正規表現の記号はそのまま文字として扱う', () => {
  assert.ok(globToRegExp('a.(1)+.png').test('a.(1)+.png'));
  assert.ok(!globToRegExp('a.png').test('aXpng'));
});

test('名前順は数値を数値として比べる', () => {
  const lr001 = filterItems(items, 'lr001');
  assert.deepEqual(rels(sortItems(lr001, 'name', 'asc')), [
    'exp_lr001_run2_loss.png',
    'exp_lr001_run10_loss.png',
  ]);
  assert.deepEqual(rels(sortItems(lr001, 'name', 'desc')), [
    'exp_lr001_run10_loss.png',
    'exp_lr001_run2_loss.png',
  ]);
});

test('更新日時・作成日時・サイズ順', () => {
  assert.deepEqual(rels(sortItems(items, 'mtime', 'asc')).slice(0, 2), ['memo.jpg', 'exp_lr001_run2_loss.png']);
  assert.equal(sortItems(items, 'mtime', 'desc')[0].rel, 'sub/Other.PNG');
  assert.equal(sortItems(items, 'ctime', 'desc')[0].rel, 'memo.jpg');
  assert.equal(sortItems(items, 'size', 'asc')[0].rel, 'sub/Other.PNG');
});

test('同じ値は名前順で安定させ、元の配列は変えない', () => {
  const before = rels(items);
  assert.deepEqual(rels(sortItems(items, 'size', 'asc')).slice(1, 3), [
    'exp_lr001_run2_loss.png',
    'exp_lr003_run2_loss.png',
  ]);
  assert.deepEqual(rels(items), before);
});

test('未知のキーは名前順', () => {
  assert.deepEqual(rels(sortItems(items, 'bogus', 'asc')), rels(sortItems(items, 'name', 'asc')));
});
