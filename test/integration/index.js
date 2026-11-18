// 実際の VS Code で拡張を動かす結合テスト。
// 使い方: code --extensionDevelopmentPath=<拡張> --extensionTestsPath=<このファイル> --user-data-dir=<短い一時フォルダ> <画像フォルダ>
// 環境変数 IMAGE_LIST_TEST_DIR に、直下に画像があり sub/ に画像 1 枚があるフォルダを渡す。
// 渡したフォルダには new_image.png を書き込んでから消すので、本物のデータのフォルダは渡さないこと。
const vscode = require('vscode');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, label, timeout = 10000) {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`タイムアウト: ${label}`);
    await sleep(100);
  }
}

const imageTabs = () =>
  vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputCustom);

async function run() {
  const dir = process.env.IMAGE_LIST_TEST_DIR;
  assert.ok(dir, 'IMAGE_LIST_TEST_DIR が未設定');
  const top = fs.readdirSync(dir).filter((n) => n.endsWith('.png'));

  // 最初のパネルの外にあるフォルダの画像(localResourceRoots を後から広げられるかを見る)
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ilv-other-'));
  const otherImg = path.join(other, 'outside.png');
  fs.copyFileSync(path.join(dir, top[0]), otherImg);
  const otherUri = vscode.Uri.file(otherImg);

  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'image-list-view');
  const api = await ext.activate();

  // 引数なしで空の一覧が開く
  const panel = await vscode.commands.executeCommand('imageListView.open');
  await waitFor(() => panel.scanSeq > 0, '空パネルの初回読み込み');
  assert.equal(panel.items.length, 0);
  console.log('OK 空の一覧');

  // Webview が読み込み直された回数(ready が来た回数)を数える
  let readyCount = 0;
  const origOnMessage = panel.onMessage.bind(panel);
  panel.onMessage = (m) => {
    if (m && m.type === 'ready') readyCount++;
    return origOnMessage(m);
  };

  // エクスプローラーのクリック相当: 標準プレビューで開くと一覧に入り、タブは閉じる
  await vscode.commands.executeCommand('vscode.open', otherUri, { preview: true, preserveFocus: true });
  await waitFor(() => panel.items.some((i) => i.name === 'outside.png'), 'クリックで追加');
  await waitFor(() => imageTabs().length === 0, 'プレビュータブを閉じる');
  await waitFor(
    () => panel.imgLoaded.has(otherUri.toString()) || panel.imgErrors.size,
    `Webview で画像を読み込めた(visible=${panel.panel.visible})`
  );
  assert.equal(panel.imgErrors.size, 0);
  console.log('OK クリックで追加・タブを閉じる・画像表示');

  // 外す → 戻す
  panel.onMessage({ type: 'remove', id: otherUri.toString() });
  await waitFor(() => panel.items.length === 0, '外す');
  panel.onMessage({ type: 'restore' });
  await waitFor(() => panel.items.length === 1, '戻す');
  console.log('OK 外す・戻す');

  // フォルダを後から追加(「+ 追加」のダイアログの後と同じ処理)
  panel.addTargets([{ uri: vscode.Uri.file(dir), isDir: true }]);
  await waitFor(() => panel.items.length === top.length + 1, `フォルダ追加で ${top.length + 1} 枚`);
  console.log(`OK フォルダ追加 ${panel.items.length} 枚`);

  // 自動更新
  const added = path.join(dir, 'new_image.png');
  fs.copyFileSync(path.join(dir, top[0]), added);
  await waitFor(() => panel.items.some((i) => i.name === 'new_image.png'), '追加の検知');
  fs.unlinkSync(added);
  await waitFor(() => !panel.items.some((i) => i.name === 'new_image.png'), '削除の検知');
  console.log('OK 自動更新');

  // フォルダ内の 1 枚を外し、同じ画像をクリックし直すと戻る
  const inDir = vscode.Uri.file(path.join(dir, top[1]));
  panel.onMessage({ type: 'remove', id: inDir.toString() });
  await waitFor(() => panel.items.length === top.length, 'フォルダ内の 1 枚を外す');
  const readyBefore = readyCount;
  await vscode.commands.executeCommand('vscode.open', inDir, { preview: true, preserveFocus: true });
  await waitFor(() => panel.items.length === top.length + 1, 'クリックし直しで戻る');
  await sleep(500);
  assert.equal(readyCount, readyBefore, '既に読めるフォルダの画像では Webview を読み込み直さない');
  assert.equal(panel.items.filter((i) => i.id === inDir.toString()).length, 1, '同じ画像が 2 回並ばない');
  console.log('OK 外した画像をクリックで戻す・重複なし');

  // 一覧の中から開いた画像はクリック追加の対象にせず、タブも閉じない
  panel.onMessage({ type: 'open', id: inDir.toString() });
  await waitFor(() => imageTabs().length === 1, '一覧から開いたタブが残る');
  for (const t of imageTabs()) await vscode.window.tabGroups.close(t);
  console.log('OK 一覧から開いたタブは閉じない');

  // サブフォルダを含める
  panel.onMessage({ type: 'state', state: { ...panel.state, recursive: true } });
  await waitFor(() => panel.items.some((i) => i.rel.startsWith('sub/')), 'サブフォルダの読み込み');
  panel.onMessage({ type: 'state', state: { ...panel.state, recursive: false } });
  await waitFor(() => !panel.items.some((i) => i.rel.startsWith('sub/')), 'サブフォルダを外す');
  console.log('OK サブフォルダ');

  // クリックで追加をオフにすると、普通にプレビューが開くだけ
  const config = () => vscode.workspace.getConfiguration('imageListView');
  assert.equal(config().get('clickToAdd'), true, '既定はオン');
  panel.onMessage({ type: 'setClickToAdd', value: false });
  await waitFor(() => config().get('clickToAdd') === false, '一覧のチェックで設定がオフになる');
  const subImg = vscode.Uri.file(path.join(dir, 'sub', fs.readdirSync(path.join(dir, 'sub'))[0]));
  await vscode.commands.executeCommand('vscode.open', subImg, { preview: true, preserveFocus: true });
  await waitFor(() => imageTabs().length === 1, 'オフ時はタブが残る');
  await sleep(500);
  assert.ok(!panel.items.some((i) => i.id === subImg.toString()), 'オフ時は追加しない');
  for (const t of imageTabs()) await vscode.window.tabGroups.close(t);
  await vscode.commands.executeCommand('imageListView.toggleClickToAdd');
  await waitFor(() => config().get('clickToAdd') === true, 'コマンドで設定がオンに戻る');
  console.log('OK クリックで追加オフ・切り替え');

  // Shift+ドロップ相当: Webview から uri-list が届くとフォルダごと足す
  const subDir = vscode.Uri.file(path.join(dir, 'sub'));
  panel.onMessage({ type: 'drop', uris: [subDir.toString(), 'not a uri'] });
  await waitFor(() => panel.items.some((i) => i.id === subImg.toString()), 'ドロップしたフォルダの画像');
  console.log('OK ドロップでフォルダ追加');

  // エクスプローラーの右クリックで 2 枚選んだ場合は新しいパネル
  const two = top.slice(0, 2).map((n) => vscode.Uri.file(path.join(dir, n)));
  const panel2 = await vscode.commands.executeCommand('imageListView.open', two[0], two);
  await waitFor(() => panel2.items.length === 2, '選んだ 2 枚だけ');
  assert.equal(api.current(), panel2, '新しいパネルがクリックの受け先になる');
  panel2.panel.dispose();
  assert.equal(api.current(), panel, '閉じたら前のパネルに戻る');
  console.log('OK 複数選択の新パネル');

  // 引数なしで開くと既存パネルを前に出すだけ
  const again = await vscode.commands.executeCommand('imageListView.open');
  assert.equal(again, panel);
  console.log('OK 既存パネルを再利用');

  // 一覧を開いていなくても、画像を開くと一覧が自動で開いて追加される
  for (const p of [...api.panels]) p.panel.dispose();
  assert.equal(api.panels.size, 0);
  await vscode.commands.executeCommand('vscode.open', otherUri, { preview: true, preserveFocus: true });
  const auto = await waitFor(() => [...api.panels][0], '一覧が自動で開く');
  await waitFor(() => auto.items.length === 1 && auto.items[0].id === otherUri.toString(), '自動で開いた一覧に追加');
  await waitFor(() => imageTabs().length === 0, '自動で開いたときもプレビュータブを閉じる');
  await waitFor(() => auto.imgLoaded.has(otherUri.toString()) || auto.imgErrors.size, '自動で開いた一覧で画像表示');
  assert.equal(auto.imgErrors.size, 0);
  console.log('OK 一覧なしでも自動で開いて追加');

  // 複数枚をまとめて開いた(ドラッグ&ドロップ相当)ときも 1 つの一覧に入る
  auto.panel.dispose();
  await Promise.all(
    top.slice(2, 5).map((n) =>
      vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(dir, n)), { preview: false, preserveFocus: true })
    )
  );
  await waitFor(() => api.panels.size === 1 && [...api.panels][0].items.length === 3, '3 枚が 1 つの一覧に入る');
  await waitFor(() => imageTabs().length === 0, '3 枚ぶんのタブを閉じる');
  console.log('OK まとめて開いても一覧は 1 つ');

  fs.rmSync(other, { recursive: true, force: true });
  const hold = Number(process.env.IMAGE_LIST_HOLD_MS || 0);
  if (hold) await sleep(hold);
}

module.exports = { run };
