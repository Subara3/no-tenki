/**
 * config.mjs — 設定の読み出し、既定値、マスク、Snowflake比較、小物
 *
 * 秘密は GitHub Secrets から環境変数で渡る。リポジトリには一切置かない。
 */

/** 3値リアクション。意味は README とピン留め文面の凡例で固定する。 */
export const EMOJI = {
  OK: '✅',            // ✅ 記録済み
  HOLD: '❓',          // ❓ 読み取れず保留（書き直して再投稿）
  RAW: '⚠️',     // ⚠️ 原文のまま記録
  RAW_FALLBACK: '⚠'   // 一部環境で VS16 なしを要求されるため
};

export const DEFAULTS = {
  MODEL: 'gpt-oss-120b',
  REQUIRE_MENTION: 'false',
  // このチャンネルが何を集めているか。プロンプトの土台になる。
  // 「業務報告」以外にも使えるのがこのツールの寿命を決める部分。
  TOPIC: '業務報告',
  CATEGORIES: 'progress,done,issue,other',
  // 集めたい対象に固有の列。ここがシートの列になり、抽出項目にもなる。
  // 業務報告なら「数値」、ゲームのサーモン収集なら「ゲーム,サーモン」のように差し替える。
  FIELDS: '数値',
  MONTHLY_LIMIT: '2700',
  MAX_BATCH: '10',
  MAX_CHARS: '1000',
  SAKURA_ENDPOINT: 'https://api.ai.sakura.ad.jp/v1/chat/completions',
  TIMEZONE: 'Asia/Tokyo'
};

/** 設定不備。fail-closed で停止させるための専用型。 */
export class ConfigError extends Error {
  constructor(message) { super(message); this.name = 'ConfigError'; }
}

/** さくらの応答が丸ごと解釈できなかったときの型（全件縮退の合図）。 */
export class BundleParseError extends Error {
  constructor(message, raw) { super(message); this.name = 'BundleParseError'; this.raw = raw; }
}

function req(env, key) {
  const v = env[key];
  if (!v) throw new ConfigError(`環境変数「${key}」が未設定です。GitHub Secrets を確認してください。`);
  return v;
}

function opt(env, key) {
  const v = env[key];
  return (v === undefined || v === null || v === '') ? DEFAULTS[key] : v;
}

export function loadConfig(env = process.env) {
  const maxBatch = parseInt(opt(env, 'MAX_BATCH'), 10);
  const maxChars = parseInt(opt(env, 'MAX_CHARS'), 10);
  const limit = parseInt(opt(env, 'MONTHLY_LIMIT'), 10);

  // COLUMNS があればそれが列の定義。無ければ v4 までの並びを FIELDS から組む。
  const columns = env.COLUMNS
    ? parseColumns(env.COLUMNS)
    : legacyColumns(parseFields(opt(env, 'FIELDS')));

  return {
    columns,
    // さくらに追加で抽出させる項目は、列定義から導く
    fields: columns.filter((c) => c.source === 'field').map((c) => c.name),
    idPrefix: parseIdPrefix(env.ID_PREFIX),
    versionChannelId: env.VERSION_CHANNEL_ID || '',
    sheetTab: env.SHEET_TAB || '',
    // 既にある表の書式（ドロップダウンなど）を、追記する行にも写すための指定。
    // 色付きチップはセルの背景ではないので、現物からコピーするしかない。
    mimicFrom: env.MIMIC_FROM_TAB || '',
    mimicColumns: env.MIMIC_COLUMNS || '',
    // 空欄に入れる既定値。`ステータス:未対応` の形。
    columnDefaults: env.COLUMN_DEFAULTS || '',
    discordToken: req(env, 'DISCORD_BOT_TOKEN'),
    sakuraKey: req(env, 'SAKURA_API_KEY'),
    channelId: req(env, 'CHANNEL_ID'),
    sheetUrl: env.SHEET_WEBAPP_URL || '',
    sheetSecret: env.SHEET_SECRET || '',
    topic: opt(env, 'TOPIC'),
    model: opt(env, 'MODEL'),
    endpoint: opt(env, 'SAKURA_ENDPOINT'),
    timezone: opt(env, 'TIMEZONE'),
    requireMention: String(opt(env, 'REQUIRE_MENTION')).toLowerCase() === 'true',
    categories: parseCategories(opt(env, 'CATEGORIES')),
    monthlyLimit: isNaN(limit) ? 2700 : limit,
    maxBatch: Math.max(1, Math.min(25, isNaN(maxBatch) ? 10 : maxBatch)),
    maxChars: Math.max(200, isNaN(maxChars) ? 1000 : maxChars),
    guildId: env.GUILD_ID || '',
    botUserId: ''
  };
}

export function parseCategories(raw) {
  const list = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULTS.CATEGORIES.split(',');
}

/** 対象固有の列。空にもできる（そのときは種別と内容だけになる）。 */
export function parseFields(raw) {
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 8);
}

/**
 * 列の値の出どころ。
 * 集める対象によって列の並びも中身も変わるので、骨格を固定しない。
 */
export const COLUMN_SOURCES = new Set([
  'autoid',      // 種別ごとの連番。シートを見ないと次の番号が決まらないので GAS 側が採番する
  'category',    // さくらが選んだ種別
  'summary',     // さくらの要約
  'field',       // さくらに追加で抽出させる任意項目（列名がキーになる）
  'author',      // Discord の表示名
  'date',        // 報告日
  'version',     // バージョン年表から決定
  'attachments', // 添付ファイルのURL（改行区切り）
  'link',        // Discordリンク
  'raw',         // 原文
  'state',       // 状態
  'msgid',       // メッセージID
  'recordedat',  // 記録日時
  'blank'        // 常に空（人が埋める欄）
]);

/**
 * `列名:出どころ` のカンマ区切りを解く。
 * 出どころを省いた場合は field（さくらに聞く項目）として扱う。
 *
 *   ID:autoid,種別:category,内容:summary,発見者:author,ステータス:blank
 */
export function parseColumns(raw) {
  const items = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  if (!items.length) throw new ConfigError('COLUMNS が空です。');

  const columns = items.map((item) => {
    const i = item.lastIndexOf(':');
    if (i < 0) return { name: item, source: 'field' };
    const name = item.slice(0, i).trim();
    const source = item.slice(i + 1).trim();
    if (!name) throw new ConfigError(`COLUMNS の列名が空です: 「${item}」`);
    if (!COLUMN_SOURCES.has(source)) {
      throw new ConfigError(
        `COLUMNS の「${item}」の出どころ「${source}」は使えません。` +
        `使えるのは: ${[...COLUMN_SOURCES].join(' / ')}`
      );
    }
    return { name, source };
  });

  const seen = new Set();
  for (const c of columns) {
    if (seen.has(c.name)) throw new ConfigError(`COLUMNS に同じ列名が2回あります: 「${c.name}」`);
    seen.add(c.name);
  }
  return columns;
}

/** COLUMNS 未設定時の並び。v4 までの形をそのまま保つ。 */
export function legacyColumns(fields) {
  return [
    { name: '記録日時', source: 'recordedat' },
    { name: '報告日', source: 'date' },
    { name: '報告者', source: 'author' },
    { name: '種別', source: 'category' },
    ...fields.map((f) => ({ name: f, source: 'field' })),
    { name: '内容', source: 'summary' },
    { name: '原文', source: 'raw' },
    { name: '状態', source: 'state' },
    { name: 'メッセージID', source: 'msgid' },
    { name: 'Discordリンク', source: 'link' }
  ];
}

/** シートの見出し行。 */
export function reportHeaders(cfg) {
  return cfg.columns.map((c) => c.name);
}

/** `要望:R,*:B` の形を解く。`*` は既定。 */
export function parseIdPrefix(raw) {
  const map = {};
  String(raw || '').split(',').map((s) => s.trim()).filter(Boolean).forEach((pair) => {
    const i = pair.lastIndexOf(':');
    if (i < 0) return;
    map[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  });
  return map;
}

/* ------------------------------------------------------------------ */
/* Snowflake（Discord ID）                                              */
/* ------------------------------------------------------------------ */

/**
 * Discord の ID は 64bit。Number にすると精度が壊れるので必ず文字列で比較する。
 * 桁数 → 辞書順 の2段。
 */
export function cmpId(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function maxId(a, b) {
  if (!a) return b;
  if (!b) return a;
  return cmpId(a, b) >= 0 ? a : b;
}

const DISCORD_EPOCH_MS = 1420070400000;

/** 指定時刻を表す最小の snowflake を作る（遡り取り込み用）。 */
export function snowflakeFromMs(ms) {
  const n = Math.max(0, Math.floor(ms) - DISCORD_EPOCH_MS);
  return shiftLeft22(String(n));
}

/** 10進文字列を 2^22 倍する。Number の安全域を超えるので手で計算する。 */
function shiftLeft22(decStr) {
  const digits = String(decStr).split('').map(Number);
  for (let t = 0; t < 22; t++) {
    let carry = 0;
    for (let i = digits.length - 1; i >= 0; i--) {
      const v = digits[i] * 2 + carry;
      digits[i] = v % 10;
      carry = (v - digits[i]) / 10;
    }
    while (carry > 0) {
      digits.unshift(carry % 10);
      carry = Math.floor(carry / 10);
    }
  }
  return digits.join('').replace(/^0+(?=\d)/, '');
}

/* ------------------------------------------------------------------ */
/* マスク（ログに出す前に必ず通す）                                       */
/* ------------------------------------------------------------------ */

/**
 * 公開リポジトリなので Actions のログは誰でも読める。
 * 秘密の形をした文字列は、実際の値も形状も両方から潰す。
 */
export function mask(value, env = process.env) {
  let t = (value === null || value === undefined) ? String(value)
    : (value instanceof Error) ? String(value.message)
      : String(value);

  for (const k of ['DISCORD_BOT_TOKEN', 'SAKURA_API_KEY', 'SHEET_SECRET', 'SHEET_WEBAPP_URL']) {
    const v = env[k];
    if (v && v.length >= 8) t = t.split(v).join(`***${k}***`);
  }

  t = t.replace(/Bearer\s+\S+/gi, 'Bearer ***');
  t = t.replace(/Bot\s+[A-Za-z0-9_.-]{20,}/g, 'Bot ***');
  t = t.replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}\b/g, '***TOKEN***');
  t = t.replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:[A-Za-z0-9._~-]+/g, '***KEY***');
  return t;
}

/* ------------------------------------------------------------------ */
/* 小物                                                                */
/* ------------------------------------------------------------------ */

export function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * タイムゾーン付きの YYYY-MM-DD。
 * ロケールの表示順に依存しないよう formatToParts で年月日を個別に取り出す。
 * （en-CA なら ISO 形式、という前提は ICU の構成によって崩れる）
 */
export function dateKey(date = new Date(), timeZone = DEFAULTS.TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function monthKey(date = new Date(), timeZone = DEFAULTS.TIMEZONE) {
  return dateKey(date, timeZone).slice(0, 7);
}

export function truncate(s, n) {
  s = String(s === null || s === undefined ? '' : s);
  return s.length <= n ? s : s.slice(0, n) + '…';
}

/** 制御文字とゼロ幅を落として、連続空行を畳む。プロンプト混入対策の下ごしらえ。 */
export function normalizeText(s) {
  return String(s || '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u200b-\u200d\ufeff]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
