/**
 * Code.gs — スプレッドシート側の受け口
 *
 * スプレッドシートを開いて「拡張機能 → Apps Script」に貼り、
 * ウェブアプリとしてデプロイして、その URL を GitHub Secrets の SHEET_WEBAPP_URL に入れる。
 *
 * ここに Discord トークンもさくらキーも置かない。持つのは合言葉ひとつだけ。
 * 合言葉はスクリプトプロパティ SHEET_SECRET に入れる（GitHub 側と同じ値）。
 */

/**
 * 列は送信側（GitHub Actions）が決めて headers として渡してくる。
 * 集める対象によって列が変わる（業務報告なら「数値」、ゲームのサーモン収集なら「ゲーム」「サーモン」）ため、
 * ここでは固定しない。これは既定値で、headers が来なければこれを使う。
 */
const DEFAULT_REPORT_HEADERS = [
  '記録日時', '報告日', '報告者', '種別', '数値', '内容', '原文', '状態', 'メッセージID', 'Discordリンク'
];
const USAGE_HEADERS = [
  '日時', '種別', '入口', '束ね件数', '✅', '❓', '⚠️', '見送り', 'モデル', '所要ms', '備考'
];
const ERROR_HEADERS = ['日時', '区分', 'メッセージID', '内容', '原文', 'リンク'];

const USAGE_SHEET = '使用量';
const ERROR_SHEET = 'エラー';

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    const expected = PropertiesService.getScriptProperties().getProperty('SHEET_SECRET');
    if (!expected || body.secret !== expected) {
      return json_({ ok: false, error: 'unauthorized' });
    }

    const book = SpreadsheetApp.getActive();
    let appended = 0;

    if (Array.isArray(body.reportRows) && body.reportRows.length) {
      const headers = (Array.isArray(body.headers) && body.headers.length)
        ? body.headers : DEFAULT_REPORT_HEADERS;
      const idCol = headers.indexOf('メッセージID');
      const sh = monthSheet_(book, body.monthKey, headers);
      const known = existingIds_(sh, idCol);
      const fresh = body.reportRows.filter(function (r) {
        return idCol < 0 || !known[String(r[idCol]).replace(/^'/, '')];
      });
      if (fresh.length) {
        sh.getRange(sh.getLastRow() + 1, 1, fresh.length, headers.length)
          .setValues(fresh.map(function (r) { return toRow_(r, idCol); }));
        appended = fresh.length;
      }
    }

    if (body.usageRow) {
      const sh = ensure_(book, USAGE_SHEET, USAGE_HEADERS);
      sh.appendRow(withNow_(body.usageRow));
    }

    if (Array.isArray(body.errorRows) && body.errorRows.length) {
      const sh = ensure_(book, ERROR_SHEET, ERROR_HEADERS);
      body.errorRows.forEach(function (r) { sh.appendRow(withNow_(r)); });
    }

    return json_({ ok: true, appended: appended });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/**
 * ピン留めしたリンクを押したときの入口。
 * GitHub Actions の取り込みを起動するだけで、ここでは何も読まないし何も書かない。
 *
 * 鍵は SHEET_SECRET とは別の INGEST_KEY を使う。
 * URL に載る鍵と、行を書き込める鍵を同じにしてはいけない。
 */
function doGet(e) {
  const p = (e && e.parameter) || {};
  const props = PropertiesService.getScriptProperties();

  if (p.ping === 'github') {
    // トークンを作る前に、GAS から GitHub API に届くかだけを見る（認証不要のエンドポイント）。
    try {
      const res = UrlFetchApp.fetch('https://api.github.com/rate_limit', { muteHttpExceptions: true });
      return json_({ ok: res.getResponseCode() === 200, status: res.getResponseCode() });
    } catch (err) {
      // 認証不要のGETなので、原因の切り分けのため中身をそのまま返す。
      // スコープ未承認なのか、経路が塞がれているのかで打ち手が変わる。
      return json_({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }
  if (p.ping) return json_({ ok: true, service: 'no-tenki sheet sink' });

  const key = props.getProperty('INGEST_KEY');
  if (!key || p.k !== key) {
    return page_('このリンクは使えません', 'シートの「取り込み」タブにある正しいリンクを開いてください。');
  }

  const r = dispatch_('link');
  return r.ok
    ? page_('取り込みを始めました', '数分でシートに反映されます。結果は Discord のリアクションでも分かります。')
    : page_('起動できませんでした', r.detail);
}

/** シートを開いた瞬間の入口。設置は setupTrigger() で一度だけ。 */
function onOpenIngest() {
  const r = dispatch_('sheet');
  try {
    SpreadsheetApp.getActive().toast(
      r.ok ? '取り込みを始めました。数分でこのシートに追いつきます。' : '起動できませんでした: ' + r.detail,
      'No転記', 6
    );
  } catch (ignore) { /* トーストの失敗は処理の成否と無関係 */ }
}

/** GitHub Actions の取り込みを起動する。Discord にもさくらにも触らない。 */
function dispatch_(source) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('GITHUB_TOKEN');
  const repo = props.getProperty('GITHUB_REPO');
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
      payload: JSON.stringify({
        event_type: 'no-tenki-ingest',
        client_payload: { source: source }
      }),
      muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    if (code === 204) return { ok: true };
    return { ok: false, detail: 'GitHub API が ' + code + ' を返しました' };
  } catch (err) {
    return { ok: false, detail: '通信に失敗しました' };
  }
}

/**
 * エディタから実行して、外部通信の承認を通すための関数。
 * setupTrigger() は UrlFetchApp を呼ばないので、それだけでは
 * script.external_request の承認画面が出ないことがある。
 * これは必ず通信するので、実行すれば確実に承認が要求される。
 */
function checkGitHub() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('GITHUB_TOKEN');
  const repo = props.getProperty('GITHUB_REPO');
  const lines = [];

  lines.push(token ? 'OK  GITHUB_TOKEN 設定済み' : 'NG  GITHUB_TOKEN が未設定');
  lines.push(repo ? 'OK  GITHUB_REPO = ' + repo : 'NG  GITHUB_REPO が未設定');

  const anon = UrlFetchApp.fetch('https://api.github.com/rate_limit', { muteHttpExceptions: true });
  lines.push('OK  外部通信の承認（GitHub API に HTTP ' + anon.getResponseCode() + '）');

  if (token && repo) {
    const res = UrlFetchApp.fetch('https://api.github.com/repos/' + repo, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' },
      muteHttpExceptions: true
    });
    const c = res.getResponseCode();
    lines.push(c === 200
      ? 'OK  トークンでリポジトリを読めます'
      : 'NG  トークンでリポジトリを読めません（HTTP ' + c + '）。権限は Contents: Read and write が要ります');
  }

  const out = lines.join('\n');
  Logger.log(out);
  return out;
}

/** 初回に一度だけ実行する。シートを開いたときの取り込みを設置し、ピン留め用URLを出す。 */
function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'onOpenIngest') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onOpenIngest').forSpreadsheet(SpreadsheetApp.getActive()).onOpen().create();

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('INGEST_KEY')) {
    props.setProperty('INGEST_KEY', Utilities.getUuid().replace(/-/g, ''));
  }
  const url = ScriptApp.getService().getUrl();
  const out = url
    ? 'シートを開いたときの取り込みを設置しました。\nDiscord にピン留めするURL:\n' +
      url + '?k=' + props.getProperty('INGEST_KEY')
    : 'トリガーは設置しました。ウェブアプリとしてデプロイしてから、もう一度実行するとURLが出ます。';
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

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** 先頭を日時に差し替える。時刻はシート側で打つ（実行環境の時計に依存させない）。 */
function withNow_(row) {
  const copy = row.slice();
  copy[0] = new Date();
  return copy;
}

/** メッセージIDは文字列固定。数値に丸められると Snowflake が壊れる。 */
function toRow_(row, idCol) {
  const copy = row.slice();
  copy[0] = new Date();
  if (idCol >= 0) copy[idCol] = "'" + String(copy[idCol]).replace(/^'/, '');
  return copy;
}

function monthSheet_(book, key, headers) {
  const name = key || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
  let sh = book.getSheetByName(name);
  if (sh) {
    // FIELDS を変えると列の並びが変わる。既存シートに黙って追記すると全部ずれるので止める。
    const width = Math.max(sh.getLastColumn(), headers.length);
    const current = sh.getRange(1, 1, 1, width).getValues()[0]
      .map(function (v) { return String(v); }).slice(0, headers.length);
    if (current.join('\t') !== headers.join('\t')) {
      throw new Error(
        '列の並びが変わっています。シート「' + name + '」の見出しは [' + current.join(', ') + '] ですが、' +
        '送られてきたのは [' + headers.join(', ') + '] です。' +
        '既存シートの名前を変えてから再実行してください（新しい列で作り直します）。'
      );
    }
    return sh;
  }
  sh = book.insertSheet(name, 0);
  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#e8eaed');
  sh.setFrozenRows(1);
  const content = headers.indexOf('内容');
  const raw = headers.indexOf('原文');
  if (content >= 0) sh.setColumnWidth(content + 1, 320);
  if (raw >= 0) sh.setColumnWidth(raw + 1, 320);
  return sh;
}

function ensure_(book, name, headers) {
  let sh = book.getSheetByName(name);
  if (sh) return sh;
  sh = book.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#e8eaed');
  sh.setFrozenRows(1);
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
