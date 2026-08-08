/**
 * Code.gs（スタンドアロン版）— 他人のスプレッドシートへ書くための受け口
 *
 * シートに紐づいたスクリプトは `spreadsheets.currentonly` で自分のファイルしか触れない。
 * 共同編集しているファイル（他人の所有）へ書くには、スタンドアロンのスクリプトから
 * openById で開く必要がある。設計 v3 の分離構成と同じ形。
 *
 * ■ できることを構造的に狭める
 *   - 追記だけ。既存行の更新も削除も、このファイルには書いていない
 *   - 書くのは SHEET_TAB で指定した1タブだけ。他のタブには触れない
 *   - 見出しが合わなければ拒否する（列がずれた行を積むより落とす）
 *
 * ■ スクリプトプロパティ
 *   SHEET_ID       … 書き込み先スプレッドシートのID
 *   SHEET_TAB      … 書き込み先のタブ名（例: Discord報告（自動））
 *   SHEET_SECRET   … 書き込みの合言葉（GitHub Secrets と同じ値）
 *   INGEST_KEY     … 取り込み起動用の鍵（SHEET_SECRET とは別にする）
 *   GITHUB_TOKEN   … Actions を起動するためのトークン（Contents: Read and write）
 *   GITHUB_REPO    … 例: Subara3/no-tenki
 *   USAGE_TAB      … 使用量の記録先タブ名（省略可。既定 使用量）
 *   ERROR_TAB      … エラーの記録先タブ名（省略可。既定 エラー）
 */

const USAGE_HEADERS = [
  '日時', '種別', '入口', '束ね件数', '✅', '❓', '⚠️', '見送り', 'モデル', '所要ms', '備考'
];
const ERROR_HEADERS = ['日時', '区分', 'メッセージID', '内容', '原文', 'リンク'];

function props_() { return PropertiesService.getScriptProperties(); }

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    const expected = props_().getProperty('SHEET_SECRET');
    if (!expected || body.secret !== expected) {
      return json_({ ok: false, error: 'unauthorized' });
    }

    const sheetId = props_().getProperty('SHEET_ID');
    if (!sheetId) return json_({ ok: false, error: 'SHEET_ID が未設定です' });
    const book = SpreadsheetApp.openById(sheetId);

    // ピン留め用の鍵を発行して返す。まだ無ければ作る。
    // SHEET_SECRET は既に行を書ける権限なので、取り込みを起動できる鍵を渡しても権限は増えない。
    if (body.action === 'ingestKey') {
      let key = props_().getProperty('INGEST_KEY');
      if (!key) {
        key = Utilities.getUuid().replace(/-/g, '');
        props_().setProperty('INGEST_KEY', key);
      }
      return json_({ ok: true, url: ScriptApp.getService().getUrl() + '?k=' + key });
    }

    // 保守用。順序が崩れたときだけ呼ぶ。通常の取り込みでは通らない経路。
    if (body.action === 'reorder') {
      return json_(reorderTab_(book, body.idPrefix || {}, {
        columnDefaults: body.columnDefaults,
        mimicFrom: body.mimicFrom,
        mimicColumns: body.mimicColumns
      }));
    }

    let appended = 0;

    if (Array.isArray(body.reportRows) && body.reportRows.length) {
      const headers = body.headers;
      if (!Array.isArray(headers) || !headers.length) {
        return json_({ ok: false, error: 'headers が送られていません' });
      }
      // 書き込み先は必ずプロパティで固定する。送信側の指定では書き換えられないようにする。
      const tabName = props_().getProperty('SHEET_TAB') || body.tab;
      if (!tabName) return json_({ ok: false, error: 'SHEET_TAB が未設定です' });

      const sh = targetTab_(book, tabName, headers);
      const idCol = headers.indexOf('メッセージID');
      const known = existingIds_(sh, idCol);
      const fresh = body.reportRows.filter(function (r) {
        return idCol < 0 || !known[String(r[idCol]).replace(/^'/, '')];
      });

      if (fresh.length) {
        const rows = assignIds_(sh, headers, fresh, body.idPrefix || {});
        fillDefaults_(headers, rows, body.columnDefaults);
        const startRow = sh.getLastRow() + 1;
        sh.getRange(startRow, 1, rows.length, headers.length).setValues(rows);
        // 手で作った表の書式とドロップダウンを、追記した行にも写す
        applyMimic_(book, sh, headers, startRow, rows.length,
          { from: body.mimicFrom, columns: body.mimicColumns });
        appended = rows.length;
      }
    }

    if (body.usageRow) {
      const name = props_().getProperty('USAGE_TAB') || '使用量';
      appendRow_(book, name, USAGE_HEADERS, body.usageRow);
    }

    if (Array.isArray(body.errorRows) && body.errorRows.length) {
      const name = props_().getProperty('ERROR_TAB') || 'エラー';
      body.errorRows.forEach(function (r) { appendRow_(book, name, ERROR_HEADERS, r); });
    }

    return json_({ ok: true, appended: appended });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/* ------------------------------------------------------------------ */
/* 書き込み先タブ                                                       */
/* ------------------------------------------------------------------ */

function targetTab_(book, name, headers) {
  let sh = book.getSheetByName(name);
  if (!sh) {
    sh = book.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#e8eaed');
    sh.setFrozenRows(1);
    ['内容', '原文', '備考'].forEach(function (label) {
      const i = headers.indexOf(label);
      if (i >= 0) sh.setColumnWidth(i + 1, 320);
    });
    return sh;
  }

  // 列の並びが変わったまま追記すると全部ずれる。黙ってずらすより落とす。
  const width = Math.max(sh.getLastColumn(), headers.length);
  const current = sh.getRange(1, 1, 1, width).getValues()[0]
    .map(function (v) { return String(v); }).slice(0, headers.length);
  if (current.join('\t') !== headers.join('\t')) {
    throw new Error(
      '列の並びが変わっています。タブ「' + name + '」の見出しは [' + current.join(', ') + '] ですが、' +
      '送られてきたのは [' + headers.join(', ') + '] です。' +
      'タブ名を変えるか COLUMNS を戻してから再実行してください。'
    );
  }
  return sh;
}

/** 同じメッセージIDの行を二度作らないための保険。 */
function existingIds_(sh, idCol) {
  const map = {};
  if (idCol < 0) return map;
  const last = sh.getLastRow();
  if (last < 2) return map;
  sh.getRange(2, idCol + 1, last - 1, 1).getValues().forEach(function (r) {
    const v = String(r[0] || '').replace(/^'/, '');
    if (v) map[v] = true;
  });
  return map;
}

/* ------------------------------------------------------------------ */
/* ID の採番                                                           */
/* ------------------------------------------------------------------ */

/**
 * 種別ごとの連番を振る。次の番号を知っているのはシートだけなので、ここでやる。
 * idPrefix は { "要望": "R", "*": "B" } の形。
 */
function assignIds_(sh, headers, rows, idPrefix) {
  const idCol = headers.indexOf('ID');
  if (idCol < 0) {
    return rows.map(function (row) { return stampTime_(row, headers); });
  }

  const catCol = headers.indexOf('種別');
  const next = maxNumbers_(sh, idCol);

  return rows.map(function (row) {
    const copy = stampTime_(row, headers);
    const category = catCol >= 0 ? String(copy[catCol] || '') : '';
    const prefix = idPrefix[category] || idPrefix['*'] || 'B';
    next[prefix] = (next[prefix] || 0) + 1;
    copy[idCol] = prefix + '-' + ('0' + next[prefix]).slice(-2);
    return copy;
  });
}

/** 既にある ID から、プレフィックスごとの最大番号を拾う。 */
function maxNumbers_(sh, idCol) {
  const out = {};
  const last = sh.getLastRow();
  if (last < 2) return out;
  sh.getRange(2, idCol + 1, last - 1, 1).getValues().forEach(function (r) {
    const m = String(r[0] || '').match(/^([A-Za-z]+)-(\d+)$/);
    if (!m) return;
    const p = m[1];
    const n = parseInt(m[2], 10);
    if (!out[p] || n > out[p]) out[p] = n;
  });
  return out;
}

/**
 * 空欄に既定値を入れる。`ステータス:未対応` の形。
 * 送信側から渡された値を優先し、無ければスクリプトプロパティを見る。
 * （設定画面での保存が通らない環境があるため、両方から受けられるようにしている）
 */
function fillDefaults_(headers, rows, fromBody) {
  const raw = fromBody || props_().getProperty('COLUMN_DEFAULTS');
  if (!raw) return;
  const pairs = raw.split(',').map(function (s) { return s.trim(); }).filter(String);
  pairs.forEach(function (pair) {
    const i = pair.lastIndexOf(':');
    if (i < 0) return;
    const col = headers.indexOf(pair.slice(0, i).trim());
    const val = pair.slice(i + 1).trim();
    if (col < 0) return;
    rows.forEach(function (r) {
      if (r[col] === '' || r[col] === null || r[col] === undefined) r[col] = val;
    });
  });
}

/**
 * 手で作った表の書式とドロップダウンを、追記した行に写す。
 * 色付きチップは背景色ではないので、getBackgrounds では取れない。書式ごとコピーする。
 * `MIMIC_FROM_TAB=Discord報告` / `MIMIC_COLUMNS=ステータス`
 */
function applyMimic_(book, sh, headers, startRow, count, opts) {
  opts = opts || {};
  const fromName = opts.from || props_().getProperty('MIMIC_FROM_TAB');
  if (!fromName) return;
  const src = book.getSheetByName(fromName);
  if (!src || src.getLastRow() < 2) return;

  const srcHeaders = src.getRange(1, 1, 1, src.getLastColumn()).getValues()[0].map(String);
  const cols = (opts.columns || props_().getProperty('MIMIC_COLUMNS') || 'ステータス')
    .split(',').map(function (s) { return s.trim(); }).filter(String);

  cols.forEach(function (name) {
    const d = headers.indexOf(name);
    const s = srcHeaders.indexOf(name);
    if (d < 0 || s < 0) return;
    const from = src.getRange(2, s + 1);
    const to = sh.getRange(startRow, d + 1, count, 1);
    from.copyTo(to, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    from.copyTo(to, SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);
  });
}

/* ------------------------------------------------------------------ */
/* 並べ直し（保守用）                                                   */
/* ------------------------------------------------------------------ */

/**
 * 対象タブを投稿の時系列に並べ直し、ID を振り直す。
 *
 * 通常の取り込みは投稿ID順に追記するので、この操作は要らない。
 * 積み残しを複数回に分けて入れたときなど、順序が崩れた場合の後始末用。
 *
 * **この関数だけは既存行を書き換える。** 呼ぶには SHEET_SECRET が必要で、
 * 触るのは SHEET_TAB で指定したタブだけ。ステータスや備考は行ごと移動するので消えない。
 */
function reorderTab_(book, idPrefix, opts) {
  opts = opts || {};
  const tabName = props_().getProperty('SHEET_TAB');
  const sh = book.getSheetByName(tabName);
  if (!sh) return { ok: false, error: 'タブがありません' };

  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 3) return { ok: true, moved: 0 };

  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const idCol = headers.indexOf('ID');
  const msgCol = headers.indexOf('メッセージID');
  if (msgCol < 0) return { ok: false, error: 'メッセージID列がありません' };

  const range = sh.getRange(2, 1, lastRow - 1, lastCol);
  const rows = range.getValues();

  // Snowflake は桁数→辞書順で比べる。Number にすると精度が壊れる。
  const key = function (r) { return String(r[msgCol]).replace(/^'/, ''); };
  rows.sort(function (a, b) {
    const x = key(a), y = key(b);
    if (x.length !== y.length) return x.length < y.length ? -1 : 1;
    return x < y ? -1 : (x > y ? 1 : 0);
  });

  // 並べ直したので ID も振り直す。備考に ID を書いていると参照が崩れるため、
  // 空でない備考がある場合は振り直さない。
  const noteCol = headers.indexOf('備考');
  const notesUsed = noteCol >= 0 && rows.some(function (r) { return String(r[noteCol] || '').trim(); });
  if (idCol >= 0 && !notesUsed) {
    const catCol = headers.indexOf('種別');
    const n = {};
    rows.forEach(function (r) {
      const category = catCol >= 0 ? String(r[catCol] || '') : '';
      const prefix = idPrefix[category] || idPrefix['*'] || 'B';
      n[prefix] = (n[prefix] || 0) + 1;
      r[idCol] = prefix + '-' + ('0' + n[prefix]).slice(-2);
    });
  }

  // 空欄の既定値と、手で作った表の書式を既存行にも当てる。
  // 追記時にしか当たらないと、先に入れた行だけドロップダウンが無い状態になる。
  fillDefaults_(headers, rows, opts.columnDefaults);
  range.setValues(rows);
  applyMimic_(book, sh, headers, 2, rows.length,
    { from: opts.mimicFrom, columns: opts.mimicColumns });

  return { ok: true, moved: rows.length, renumbered: idCol >= 0 && !notesUsed };
}

/* ------------------------------------------------------------------ */
/* 共通                                                               */
/* ------------------------------------------------------------------ */

/**
 * 「記録日時」列に時刻を打つ。列名で探すのが要点。
 * 位置で決め打ちすると、先頭が ID の表で ID 列に日時が入ってしまう。
 * 時刻をシート側で打つのは、実行環境の時計に依存させないため。
 */
function stampTime_(row, headers) {
  const copy = row.slice();
  const i = headers.indexOf('記録日時');
  if (i >= 0 && (copy[i] === null || copy[i] === undefined || copy[i] === '')) copy[i] = new Date();
  return copy;
}

function appendRow_(book, name, headers, row) {
  let sh = book.getSheetByName(name);
  if (!sh) {
    sh = book.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#e8eaed');
    sh.setFrozenRows(1);
  }
  // 使用量とエラーは先頭が「日時」で固定
  const copy = row.slice();
  if (copy[0] === null || copy[0] === undefined || copy[0] === '') copy[0] = new Date();
  sh.appendRow(copy);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------ */
/* 取り込みの起動（ピン留めリンク／シートを開いたとき）                     */
/* ------------------------------------------------------------------ */

function doGet(e) {
  const p = (e && e.parameter) || {};

  if (p.ping === 'github') {
    try {
      const res = UrlFetchApp.fetch('https://api.github.com/rate_limit', { muteHttpExceptions: true });
      return json_({ ok: res.getResponseCode() === 200, status: res.getResponseCode() });
    } catch (err) {
      return json_({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }
  if (p.ping === 'config') {
    // 書き込み先の確認用。タブ名とシート名は秘密ではないので返す。
    const id = props_().getProperty('SHEET_ID');
    const tab = props_().getProperty('SHEET_TAB');
    let bookName = null, rows = null;
    try {
      const book = SpreadsheetApp.openById(id);
      bookName = book.getName();
      const sh = book.getSheetByName(tab);
      rows = sh ? sh.getLastRow() : 0;
    } catch (err) { bookName = 'エラー: ' + err.message; }
    return json_({ ok: true, tab: tab, book: bookName, lastRow: rows });
  }
  if (p.ping === 'mimic') {
    // 手で作った表の書式を読み取る。真似るには現物を見るしかない。
    // 返すのは選択肢と色だけで、報告の中身は返さない。
    try {
      const book = SpreadsheetApp.openById(props_().getProperty('SHEET_ID'));
      const sh = book.getSheetByName(p.from || 'Discord報告');
      if (!sh) return json_({ ok: false, error: 'タブが見つかりません' });

      const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
      const col = headers.indexOf(p.col || 'ステータス');
      if (col < 0) return json_({ ok: false, error: '列が見つかりません', headers: headers });

      const last = Math.min(sh.getLastRow(), 40);
      const rng = sh.getRange(2, col + 1, Math.max(1, last - 1), 1);
      const values = rng.getValues().map(function (r) { return String(r[0]); });
      const colors = rng.getBackgrounds().map(function (r) { return r[0]; });
      const fonts = rng.getFontColors().map(function (r) { return r[0]; });

      // 値ごとの色（最初に見つかったものを採る）
      const palette = {};
      values.forEach(function (v, i) {
        if (v && !palette[v]) palette[v] = { bg: colors[i], font: fonts[i] };
      });

      // ドロップダウンの選択肢
      let list = null;
      const rule = sh.getRange(2, col + 1).getDataValidation();
      if (rule) {
        try { list = rule.getCriteriaValues()[0]; } catch (e) { list = 'criteria=' + rule.getCriteriaType(); }
      }

      return json_({
        ok: true, tab: sh.getName(), headers: headers,
        statusColumn: headers[col], dropdown: list, palette: palette
      });
    } catch (err) {
      return json_({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }
  if (p.ping) return json_({ ok: true, service: 'no-tenki standalone sink' });

  const key = props_().getProperty('INGEST_KEY');
  if (!key || p.k !== key) {
    return page_('このリンクは使えません', '正しいリンクを開いてください。');
  }

  const r = dispatch_('link');
  return r.ok
    ? page_('取り込みを始めました', '数分でシートに反映されます。結果は Discord のリアクションでも分かります。')
    : page_('起動できませんでした', r.detail);
}

function dispatch_(source) {
  const token = props_().getProperty('GITHUB_TOKEN');
  const repo = props_().getProperty('GITHUB_REPO');
  if (!token || !repo) return { ok: false, detail: 'GITHUB_TOKEN / GITHUB_REPO が未設定です' };
  try {
    const res = UrlFetchApp.fetch('https://api.github.com/repos/' + repo + '/dispatches', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      payload: JSON.stringify({ event_type: 'no-tenki-ingest', client_payload: { source: source } }),
      muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    return code === 204 ? { ok: true } : { ok: false, detail: 'GitHub API が ' + code + ' を返しました' };
  } catch (err) {
    return { ok: false, detail: '通信に失敗しました' };
  }
}

/**
 * 書き込み先のシートを開いたときに取り込みを走らせるトリガーを設置する。
 * スタンドアロンでも、アクセスできるスプレッドシートに対して設置できる。
 * 誰が開いても発火し、実行はこのスクリプトの持ち主として行われる。
 *
 * つまり「シートの持ち主が表を開いたら、その時点までの報告が追いついている」になる。
 */
function setupOpenTrigger() {
  const sheetId = props_().getProperty('SHEET_ID');
  if (!sheetId) return 'SHEET_ID が未設定です';

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'onSheetOpen') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onSheetOpen').forSpreadsheet(sheetId).onOpen().create();

  const out = 'シートを開いたときの取り込みを設置しました。';
  Logger.log(out);
  return out;
}

function onSheetOpen() {
  dispatch_('sheet');
}

/** 外部通信の承認を確実に通すために、エディタから実行する。設定も一緒に検査する。 */
function checkSetup() {
  const lines = [];
  const need = ['SHEET_ID', 'SHEET_TAB', 'SHEET_SECRET', 'GITHUB_TOKEN', 'GITHUB_REPO'];
  need.forEach(function (k) {
    lines.push((props_().getProperty(k) ? 'OK  ' : 'NG  ') + k);
  });

  const sheetId = props_().getProperty('SHEET_ID');
  if (sheetId) {
    try {
      const book = SpreadsheetApp.openById(sheetId);
      lines.push('OK  スプレッドシートを開けます（' + book.getName() + '）');
      const tab = props_().getProperty('SHEET_TAB');
      lines.push(book.getSheetByName(tab) ? 'OK  タブ「' + tab + '」あり' : '--  タブ「' + tab + '」は初回書き込み時に作られます');
    } catch (err) {
      lines.push('NG  スプレッドシートを開けません: ' + err.message);
    }
  }

  const anon = UrlFetchApp.fetch('https://api.github.com/rate_limit', { muteHttpExceptions: true });
  lines.push('OK  外部通信の承認（GitHub API に HTTP ' + anon.getResponseCode() + '）');

  const token = props_().getProperty('GITHUB_TOKEN');
  const repo = props_().getProperty('GITHUB_REPO');
  if (token && repo) {
    const res = UrlFetchApp.fetch('https://api.github.com/repos/' + repo, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' },
      muteHttpExceptions: true
    });
    lines.push(res.getResponseCode() === 200
      ? 'OK  トークンでリポジトリを読めます'
      : 'NG  トークンが不正か権限不足（HTTP ' + res.getResponseCode() + '）');
  }

  if (!props_().getProperty('INGEST_KEY')) {
    props_().setProperty('INGEST_KEY', Utilities.getUuid().replace(/-/g, ''));
    lines.push('--  INGEST_KEY を発行しました');
  }
  const url = ScriptApp.getService().getUrl();
  lines.push(url
    ? 'OK  ピン留め用URL:\n    ' + url + '?k=' + props_().getProperty('INGEST_KEY')
    : '--  ウェブアプリとしてデプロイすると、ここにURLが出ます');

  const out = lines.join('\n');
  Logger.log(out);
  return out;
}

function page_(title, body) {
  const esc = function (s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };
  return HtmlService.createHtmlOutput(
    '<style>' +
    ':root{color-scheme:light dark}' +
    'body{margin:0;padding:48px 20px;font-family:-apple-system,"Segoe UI","Hiragino Sans","Noto Sans JP",sans-serif;' +
    'background:#faf9f7;color:#1f1d1b;display:flex;justify-content:center}' +
    '@media(prefers-color-scheme:dark){body{background:#17161a;color:#e9e6e1}}' +
    '.w{width:100%;max-width:400px}' +
    'h1{font-size:19px;line-height:1.5;margin:0 0 10px;font-weight:600}' +
    'p{font-size:14px;line-height:1.8;opacity:.7;margin:0}' +
    '.l{font-size:11px;opacity:.45;margin-top:28px;line-height:1.7}' +
    '</style>' +
    '<div class="w"><h1>' + esc(title) + '</h1><p>' + esc(body) + '</p>' +
    '<p class="l">✅ 記録した ／ ❓ 読み取れず保留（書き直して再投稿） ／ ⚠️ 原文のまま記録</p></div>'
  ).setTitle('No転記');
}
