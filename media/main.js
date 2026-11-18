(function () {
  const vscode = acquireVsCodeApi();
  const { filterItems, sortItems } = window.ImageListLogic;

  const $ = (id) => document.getElementById(id);
  const el = {
    add: $('add'),
    collect: $('collect'),
    pattern: $('pattern'),
    sortKey: $('sortKey'),
    sortDir: $('sortDir'),
    layoutVertical: $('layoutVertical'),
    layoutHorizontal: $('layoutHorizontal'),
    size: $('size'),
    sizeLabel: $('sizeLabel'),
    recursive: $('recursive'),
    recursiveWrap: $('recursiveWrap'),
    restore: $('restore'),
    count: $('count'),
    list: $('list'),
    empty: $('empty'),
  };

  let state = null;
  let clickToAdd = true; // 全体の設定なので state(パネルごとの表示設定)とは別に持つ
  let items = [];
  let loaded = false;
  let truncatedNote = '';
  // id ごとに DOM を使い回し、自動更新のたびに全画像を読み直してちらつくのを防ぐ
  const cards = new Map();

  const dateFmt = new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function metaText(item) {
    if (state.sortKey === 'size') return formatSize(item.size);
    if (state.sortKey === 'ctime') return `作成 ${dateFmt.format(item.ctime)}`;
    return `更新 ${dateFmt.format(item.mtime)}`;
  }

  function setState(patch) {
    state = { ...state, ...patch };
    vscode.setState(state);
    vscode.postMessage({ type: 'state', state });
  }

  function applyControls() {
    el.pattern.value = state.pattern;
    el.sortKey.value = state.sortKey;
    el.sortDir.textContent = state.sortDir === 'asc' ? '↑ 昇順' : '↓ 降順';
    el.sortDir.title = 'クリックで昇順と降順を切り替え';
    el.layoutVertical.classList.toggle('active', state.layout === 'vertical');
    el.layoutHorizontal.classList.toggle('active', state.layout === 'horizontal');
    el.layoutVertical.setAttribute('aria-pressed', String(state.layout === 'vertical'));
    el.layoutHorizontal.setAttribute('aria-pressed', String(state.layout === 'horizontal'));
    el.size.value = String(state.size);
    el.sizeLabel.textContent = `${state.size}px`;
    el.recursive.checked = state.recursive;
    el.list.classList.toggle('horizontal', state.layout === 'horizontal');
    document.body.style.setProperty('--img-width', `${state.size}px`);
  }

  function makeCard(item) {
    const fig = document.createElement('figure');
    fig.className = 'card';
    fig.dataset.id = item.id;
    const img = document.createElement('img');
    // loading='lazy' は使わない。非表示中に再読み込みされた Webview では、表示に戻っても画像が読まれないままになることがあった
    img.decoding = 'async';
    img.title = 'クリックで VS Code の画像プレビューを横に開く';
    img.addEventListener('click', () => vscode.postMessage({ type: 'open', id: fig.dataset.id }));
    img.addEventListener('load', () => vscode.postMessage({ type: 'imgLoad', id: fig.dataset.id }));
    img.addEventListener('error', () => {
      fig.classList.add('broken');
      vscode.postMessage({ type: 'imgError', id: fig.dataset.id });
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove';
    remove.textContent = '×';
    remove.title = 'この画像を一覧から外す(ファイルは消えない)';
    remove.setAttribute('aria-label', '一覧から外す');
    remove.addEventListener('click', () => vscode.postMessage({ type: 'remove', id: fig.dataset.id }));
    const cap = document.createElement('figcaption');
    const name = document.createElement('span');
    name.className = 'name';
    const meta = document.createElement('span');
    meta.className = 'meta';
    cap.append(name, meta);
    fig.append(img, remove, cap);
    return fig;
  }

  function emptyMessage() {
    if (items.length) return '絞り込みに一致する画像がありません。';
    const folderHint = 'フォルダは Shift を押しながらここにドロップするか、「+ 追加」から選べます。';
    if (clickToAdd) {
      return `左のエクスプローラーで画像をクリックするか、ここにドラッグ&ドロップすると追加されます。${folderHint}`;
    }
    return `画像がありません。Shift を押しながらここにドロップするか、「+ 追加」から選んでください。`;
  }

  function render() {
    if (!state) return;
    const shown = sortItems(filterItems(items, state.pattern), state.sortKey, state.sortDir);
    const keep = new Set(shown.map((i) => i.id));
    for (const [id, card] of cards) {
      if (!keep.has(id)) {
        card.remove();
        cards.delete(id);
      }
    }
    const frag = document.createDocumentFragment();
    for (const item of shown) {
      let card = cards.get(item.id);
      if (!card) {
        card = makeCard(item);
        cards.set(item.id, card);
      }
      const img = card.querySelector('img');
      if (img.getAttribute('src') !== item.src) {
        card.classList.remove('broken');
        img.setAttribute('src', item.src);
      }
      img.alt = item.name;
      card.querySelector('.name').textContent = item.rel;
      card.querySelector('.name').title = item.rel;
      card.querySelector('.meta').textContent = metaText(item);
      frag.append(card);
    }
    // append は既存ノードを移動するだけなので、並べ替えでも画像は読み直されない
    el.list.append(frag);

    el.count.textContent = loaded ? `${shown.length} / ${items.length} 枚${truncatedNote}` : '読み込み中…';
    el.empty.hidden = !loaded || shown.length > 0;
    el.empty.textContent = emptyMessage();
  }

  el.add.addEventListener('click', () => vscode.postMessage({ type: 'add' }));
  el.restore.addEventListener('click', () => vscode.postMessage({ type: 'restore' }));
  el.collect.addEventListener('change', () => {
    clickToAdd = el.collect.checked;
    vscode.postMessage({ type: 'setClickToAdd', value: clickToAdd });
    render();
  });

  // Shift を押しながらのドロップだけが Webview に届く(押さずに落とすと VS Code が画像を開き、それを拡張側が拾う)
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    document.body.classList.add('dragging');
  });
  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) document.body.classList.remove('dragging');
  });
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    const dt = e.dataTransfer;
    if (!dt) return;
    const text = dt.getData('application/vnd.code.uri-list') || dt.getData('text/uri-list');
    const uris = text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#'));
    if (uris.length) vscode.postMessage({ type: 'drop', uris });
  });
  el.pattern.addEventListener('input', () => {
    setState({ pattern: el.pattern.value });
    render();
  });
  el.sortKey.addEventListener('change', () => {
    setState({ sortKey: el.sortKey.value });
    applyControls();
    render();
  });
  el.sortDir.addEventListener('click', () => {
    setState({ sortDir: state.sortDir === 'asc' ? 'desc' : 'asc' });
    applyControls();
    render();
  });
  el.layoutVertical.addEventListener('click', () => {
    setState({ layout: 'vertical' });
    applyControls();
  });
  el.layoutHorizontal.addEventListener('click', () => {
    setState({ layout: 'horizontal' });
    applyControls();
  });
  el.size.addEventListener('input', () => {
    setState({ size: Number(el.size.value) });
    applyControls();
  });
  el.recursive.addEventListener('change', () => {
    setState({ recursive: el.recursive.checked });
    loaded = false;
    render();
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'init') {
      // Webview を開き直したときはそのパネルで最後に使った設定を優先する
      state = { ...msg.state, ...(vscode.getState() || {}) };
      applyControls();
      render();
    } else if (msg.type === 'config') {
      clickToAdd = msg.clickToAdd;
      el.collect.checked = clickToAdd;
      render();
    } else if (msg.type === 'items') {
      items = msg.items;
      loaded = true;
      truncatedNote = msg.truncated ? `(上限 ${msg.max} 枚で打ち切り)` : '';
      el.recursiveWrap.hidden = !msg.hasFolder;
      el.restore.hidden = msg.excludedCount === 0;
      el.restore.textContent = `外した ${msg.excludedCount} 枚を戻す`;
      render();
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
