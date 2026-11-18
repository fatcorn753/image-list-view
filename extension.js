const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.avif']);
const SKIP_DIRS = new Set(['.git', 'node_modules']);
// 誤ってホームフォルダなどを選んだときに固まらないための上限
const MAX_ITEMS = 5000;
const STATE_KEY = 'imageListView.uiState';
const DEFAULT_STATE = {
  pattern: '',
  sortKey: 'name',
  sortDir: 'asc',
  layout: 'vertical',
  size: 600,
  recursive: false,
};
const CONFIG_SECTION = 'imageListView';
// VS Code 標準の画像プレビューの viewType
const IMAGE_PREVIEW_VIEW_TYPE = 'imagePreview.previewEditor';

const panels = new Set();
let current; // クリックした画像を受け取るパネル(最後に操作したもの)
// 一覧の中から開いた画像 → 開いた時刻。クリック追加の対象から外す
const selfOpened = new Map();

const isImage = (uri) => IMAGE_EXTS.has(path.extname(uri.path).toLowerCase());
const clickToAdd = () => vscode.workspace.getConfiguration(CONFIG_SECTION).get('clickToAdd', true);
const setClickToAdd = (value) =>
  vscode.workspace.getConfiguration(CONFIG_SECTION).update('clickToAdd', value, vscode.ConfigurationTarget.Global);

function consumeSelfOpened(uri) {
  const key = uri.toString();
  const at = selfOpened.get(key);
  selfOpened.delete(key);
  return at !== undefined && Date.now() - at < 5000;
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('imageListView.open', async (uri, uris) => {
      const targets = Array.isArray(uris) && uris.length ? uris : uri instanceof vscode.Uri ? [uri] : [];
      // 引数なし(ステータスバーやコマンドパレット)は空の一覧を開く。既にあればそれを前に出す
      if (!targets.length && current) {
        current.panel.reveal();
        return current;
      }
      return ImageListPanel.create(context, targets);
    }),
    vscode.commands.registerCommand('imageListView.toggleClickToAdd', () => setClickToAdd(!clickToAdd())),
    vscode.window.tabGroups.onDidChangeTabs((e) => onTabsOpened(context, e.opened))
  );

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'imageListView.open';
  const updateStatus = () => {
    const on = clickToAdd();
    status.text = on ? '$(files) 画像一覧' : '$(files) 画像一覧(追加オフ)';
    status.tooltip = on
      ? '画像一覧を開く。画像をクリックやドラッグ&ドロップで開くと、一覧に追加される'
      : '画像一覧を開く。クリックで追加はオフ(画像は普段どおり 1 枚ずつ開く)';
  };
  updateStatus();
  status.show();
  context.subscriptions.push(
    status,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${CONFIG_SECTION}.clickToAdd`)) {
        updateStatus();
        for (const p of panels) {
          p.postConfig();
        }
      }
    })
  );

  // テストから開いているパネルを調べるために返す
  return { panels, current: () => current };
}

// 画像をクリックやドラッグ&ドロップで開くと標準プレビューのタブが開くので、それを拾って一覧に入れ、タブは閉じる。
// 一覧がまだなければ、そのタブがあった場所に新しく開く(画像を開く既定の動作を一覧への追加にする)。
// 既に開いていたタブを切り替えただけ(changed)は対象にしない。ユーザーが残したいタブを閉じてしまうため。
function onTabsOpened(context, opened) {
  if (!clickToAdd()) {
    return;
  }
  for (const tab of opened) {
    const input = tab.input;
    if (!(input instanceof vscode.TabInputCustom) || input.viewType !== IMAGE_PREVIEW_VIEW_TYPE) {
      continue;
    }
    if (consumeSelfOpened(input.uri)) {
      continue;
    }
    // 複数枚をまとめてドロップすると 1 回の通知に並んで来るので、作ったパネルを続けて使えるよう同期的に作る
    const panel = current || new ImageListPanel(context, [], tab.group.viewColumn);
    panel.addTargets([{ uri: input.uri, isDir: false }]);
    vscode.window.tabGroups.close(tab, true).then(
      () => panel.panel.reveal(undefined, true),
      () => {} // ユーザーが先に閉じていた場合など。追加は済んでいるので無視してよい
    );
  }
}

function deactivate() {}

async function resolveTargets(uris) {
  const resolved = [];
  for (const uri of uris) {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const isDir = (stat.type & vscode.FileType.Directory) !== 0;
      if (isDir || isImage(uri)) {
        resolved.push({ uri, isDir });
      }
    } catch {
      // 消えたファイルは無視する
    }
  }
  return resolved;
}

class ImageListPanel {
  static async create(context, uris) {
    const targets = await resolveTargets(uris);
    return new ImageListPanel(context, targets);
  }

  constructor(context, targets, viewColumn = vscode.ViewColumn.Active) {
    this.context = context;
    this.targets = [];
    this.watchers = new Map(); // target の uri 文字列 → watcher
    this.excluded = new Set(); // 一覧から外した画像の uri 文字列
    this.state = { ...DEFAULT_STATE, ...context.globalState.get(STATE_KEY, {}) };
    this.items = [];
    this.disposables = [];
    this.refreshTimer = undefined;
    this.scanSeq = 0;
    this.imgLoaded = new Set(); // テスト用: Webview で読み込めた画像
    this.imgErrors = new Set(); // テスト用: Webview で読み込めなかった画像
    this.mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');

    this.panel = vscode.window.createWebviewPanel('imageListView', '画像一覧', viewColumn, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [this.mediaRoot],
    });
    this.panel.iconPath = new vscode.ThemeIcon('files');
    this.panel.webview.html = this.html();

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg)),
      this.panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.active) {
          current = this;
        }
      }),
      this.panel.onDidDispose(() => this.dispose())
    );
    panels.add(this);
    current = this;
    this.addTargets(targets, { refresh: false });
  }

  title() {
    if (this.targets.length === 1 && this.targets[0].isDir) {
      return `画像一覧: ${path.basename(this.targets[0].uri.path)}`;
    }
    return '画像一覧';
  }

  // 同じものが既にあれば足さない。外していた画像を足し直したときは除外を解く
  addTargets(targets, { refresh = true } = {}) {
    for (const t of targets) {
      const key = t.uri.toString();
      this.excluded.delete(key);
      if (!this.targets.some((x) => x.uri.toString() === key)) {
        this.targets.push(t);
        this.watch(t);
      }
    }
    // Webview が読めるフォルダを、追加した対象に合わせて広げる。
    // options を差し替えると Webview が読み込み直され、スクロール位置が戻るので、フォルダが増えたときだけにする
    const roots = [this.mediaRoot, ...this.targets.map((t) => (t.isDir ? t.uri : vscode.Uri.joinPath(t.uri, '..')))];
    const rootsKey = [...new Set(roots.map((u) => u.toString()))].sort().join('\n');
    if (rootsKey !== this.rootsKey) {
      this.rootsKey = rootsKey;
      this.panel.webview.options = { enableScripts: true, localResourceRoots: roots };
    }
    this.panel.title = this.title();
    if (refresh) {
      this.scheduleRefresh(0);
    }
  }

  removeItem(id) {
    this.excluded.add(id);
    this.scheduleRefresh(0);
  }

  restoreExcluded() {
    this.excluded.clear();
    this.scheduleRefresh(0);
  }

  hasFolder() {
    return this.targets.some((t) => t.isDir);
  }

  postConfig() {
    this.post({ type: 'config', clickToAdd: clickToAdd() });
  }

  // Webview に Shift を押しながらドロップされたファイルやフォルダを足す
  async addDropped(uriStrings) {
    const uris = [];
    for (const s of uriStrings) {
      try {
        uris.push(vscode.Uri.parse(s, true));
      } catch {
        // URI として読めない行は飛ばす
      }
    }
    const targets = await resolveTargets(uris);
    if (targets.length) {
      this.addTargets(targets);
    } else {
      vscode.window.showInformationMessage('画像一覧: ドロップしたものに画像やフォルダがありませんでした。');
    }
  }

  watch(t) {
    const onChange = () => this.scheduleRefresh();
    const pattern = t.isDir
      ? new vscode.RelativePattern(t.uri, '**/*')
      : new vscode.RelativePattern(vscode.Uri.joinPath(t.uri, '..'), path.basename(t.uri.path));
    const w = vscode.workspace.createFileSystemWatcher(pattern);
    w.onDidCreate(onChange);
    w.onDidChange(onChange);
    w.onDidDelete(onChange);
    this.watchers.set(t.uri.toString(), w);
  }

  // 画像を連続で書き出すと通知が何十回も来るので、まとめて 1 回だけ読み直す
  scheduleRefresh(delay = 300) {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), delay);
  }

  async refresh() {
    const seq = ++this.scanSeq;
    const found = [];
    const seen = new Set();
    let truncated = false;
    for (const t of this.targets) {
      if (found.length >= MAX_ITEMS) {
        truncated = true;
        break;
      }
      if (t.isDir) {
        truncated = (await this.scanDir(t.uri, '', found, seen)) || truncated;
      } else {
        await this.addFile(t.uri, path.basename(t.uri.path), found, seen);
      }
    }
    // 古い走査が後から終わって新しい結果を上書きしないようにする
    if (seq !== this.scanSeq) {
      return;
    }
    const shown = found.filter((i) => !this.excluded.has(i.id));
    this.items = shown;
    this.post({
      type: 'items',
      items: shown,
      excludedCount: found.length - shown.length,
      hasFolder: this.hasFolder(),
      truncated,
      max: MAX_ITEMS,
    });
  }

  async scanDir(dir, relBase, found, seen) {
    let entries;
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return false;
    }
    for (const [name, type] of entries) {
      if (found.length >= MAX_ITEMS) {
        return true;
      }
      const child = vscode.Uri.joinPath(dir, name);
      const rel = relBase ? `${relBase}/${name}` : name;
      const isLink = (type & vscode.FileType.SymbolicLink) !== 0;
      if (type & vscode.FileType.Directory) {
        // シンボリックリンクのフォルダは循環しうるので辿らない
        if (this.state.recursive && !isLink && !SKIP_DIRS.has(name) && (await this.scanDir(child, rel, found, seen))) {
          return true;
        }
      } else if (isImage(child)) {
        await this.addFile(child, rel, found, seen);
      }
    }
    return false;
  }

  async addFile(uri, rel, found, seen) {
    const id = uri.toString();
    // フォルダと、その中の画像を両方追加した場合に 2 回並ばないようにする
    if (seen.has(id)) {
      return;
    }
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      seen.add(id);
      // 同名で上書きされた画像を Webview が古いキャッシュのまま出さないよう、更新時刻をクエリに付ける
      const src = `${this.panel.webview.asWebviewUri(uri).toString()}?v=${stat.mtime}`;
      found.push({ id, src, name: path.basename(uri.path), rel, mtime: stat.mtime, ctime: stat.ctime, size: stat.size });
    } catch {
      // 走査中に消えたファイルは飛ばす
    }
  }

  async pickAndAdd() {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: true,
      openLabel: '一覧に追加',
      filters: { 画像: [...IMAGE_EXTS].map((e) => e.slice(1)) },
    });
    if (picked && picked.length) {
      this.addTargets(await resolveTargets(picked));
    }
  }

  onMessage(msg) {
    switch (msg && msg.type) {
      case 'ready':
        this.post({ type: 'init', state: this.state });
        this.postConfig();
        this.refresh();
        break;
      case 'state': {
        const recursiveChanged = msg.state.recursive !== this.state.recursive;
        this.state = { ...this.state, ...msg.state };
        // 次に開くパネルも同じ並び順・表示で始まるように覚えておく。
        // 絞り込み文字列まで引き継ぐと、別フォルダを開いたときに画像が黙って隠れるので保存しない
        const { pattern, ...rest } = this.state;
        this.context.globalState.update(STATE_KEY, rest);
        if (recursiveChanged) {
          this.refresh();
        }
        break;
      }
      case 'add':
        this.pickAndAdd();
        break;
      case 'drop':
        if (Array.isArray(msg.uris)) {
          this.addDropped(msg.uris);
        }
        break;
      case 'setClickToAdd':
        setClickToAdd(!!msg.value);
        break;
      case 'remove':
        this.removeItem(msg.id);
        break;
      case 'restore':
        this.restoreExcluded();
        break;
      case 'open': {
        const item = this.items.find((i) => i.id === msg.id);
        if (item) {
          selfOpened.set(item.id, Date.now());
          vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(item.id), {
            viewColumn: vscode.ViewColumn.Beside,
            preview: true,
          });
        }
        break;
      }
      case 'imgLoad':
        this.imgLoaded.add(msg.id);
        break;
      case 'imgError':
        this.imgErrors.add(msg.id);
        break;
    }
  }

  post(msg) {
    this.panel.webview.postMessage(msg);
  }

  html() {
    const webview = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (name) => webview.asWebviewUri(vscode.Uri.joinPath(this.mediaRoot, name));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('main.css')}">
<title>画像一覧</title>
</head>
<body>
<header class="toolbar">
  <button id="add" type="button" class="primary" title="ファイルやフォルダを選んで一覧に追加する">+ 追加</button>
  <label class="group" title="オンの間は、画像をクリックやドラッグ&ドロップで開くと、一覧に追加される(一覧を開いていなくても)。全体の設定"><input id="collect" type="checkbox"> クリックで追加</label>
  <input id="pattern" type="search" placeholder="絞り込み 例: loss / exp_*_run?_*.png" spellcheck="false">
  <label class="group">並び順
    <select id="sortKey">
      <option value="name">名前</option>
      <option value="mtime">更新日時</option>
      <option value="ctime">作成日時</option>
      <option value="size">サイズ</option>
    </select>
  </label>
  <button id="sortDir" type="button"></button>
  <span class="group seg" role="group" aria-label="並べる向き">
    <button id="layoutVertical" type="button">縦</button>
    <button id="layoutHorizontal" type="button">横</button>
  </span>
  <label class="group">幅
    <input id="size" type="range" min="80" max="2000" step="10">
    <span id="sizeLabel" class="num"></span>
  </label>
  <label class="group" id="recursiveWrap" hidden><input id="recursive" type="checkbox"> サブフォルダも含める</label>
  <button id="restore" type="button" hidden></button>
  <span id="count" class="count"></span>
</header>
<p id="empty" class="empty" hidden></p>
<main id="list" class="list"></main>
<script nonce="${nonce}" src="${uri('logic.js')}"></script>
<script nonce="${nonce}" src="${uri('main.js')}"></script>
</body>
</html>`;
  }

  dispose() {
    clearTimeout(this.refreshTimer);
    panels.delete(this);
    if (current === this) {
      current = [...panels].pop();
    }
    for (const w of this.watchers.values()) {
      w.dispose();
    }
    this.watchers.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}

module.exports = { activate, deactivate };
