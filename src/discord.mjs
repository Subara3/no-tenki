/**
 * discord.mjs — メッセージ取得・対象判定・リアクション付与
 *
 * Bot の権限は「チャンネルを見る」「メッセージ履歴を読む」「リアクションの追加」の3つだけ。
 * 送信系のエンドポイントはこのファイルに一切書かない（無口Botの担保）。
 */

import { EMOJI, ConfigError, cmpId, normalizeText, truncate, mask, safeJson } from './config.mjs';

const API = 'https://discord.com/api/v10';
const UA = 'DiscordBot (https://github.com/Subara3/no-tenki, 4.0)';

/**
 * Discord REST 呼び出し。429（レート制限）と 5xx をここで吸収する。
 * リアクション付与は 1リクエスト/250ms 程度で絞られるため 429 は日常的に起きる。
 */
export async function discordFetch(cfg, method, path, payload) {
  const opts = {
    method,
    headers: {
      Authorization: `Bot ${cfg.discordToken}`,
      'User-Agent': UA
    }
  };
  if (payload !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(payload);
  }

  let last = { code: 0, body: '' };
  for (let attempt = 0; attempt < 4; attempt++) {
    let res, body;
    try {
      // タイムアウト必須。無いと Discord が黙ったときに実行が止まったままになる。
      res = await fetch(API + path, { ...opts, signal: AbortSignal.timeout(30000) });
      body = await res.text();
    } catch (e) {
      last = { code: 0, body: `通信に失敗しました: ${mask(e)}` };
      await sleep(500 * (attempt + 1));
      continue;
    }
    last = { code: res.status, body };

    if (res.status === 429) {
      const j = safeJson(body);
      const waitMs = typeof j?.retry_after === 'number' ? Math.ceil(j.retry_after * 1000) : 1000;
      await sleep(Math.min(waitMs + 250, 8000));
      continue;
    }
    if (res.status >= 500) {
      await sleep(400 * (attempt + 1));
      continue;
    }
    return { code: res.status, body, json: safeJson(body) };
  }
  return { ...last, json: safeJson(last.body), exhausted: true };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * カーソル以降のメッセージを古い順（ID 昇順）で返す。
 * Discord は配列を新しい順で返すので、こちらで必ず並べ直す。
 */
export async function fetchMessagesAfter(cfg, afterId, limit = 100) {
  const n = Math.max(1, Math.min(100, limit));
  const path = `/channels/${cfg.channelId}/messages?limit=${n}&after=${encodeURIComponent(afterId)}`;
  const res = await discordFetch(cfg, 'GET', path);

  if (res.code === 401) throw new ConfigError('Discord Bot トークンが不正です（401）。');
  if (res.code === 403) throw new ConfigError('Bot にチャンネルの閲覧／履歴の権限がありません（403）。');
  if (res.code === 404) throw new ConfigError('CHANNEL_ID のチャンネルが見つかりません（404）。');
  if (res.code !== 200 || !Array.isArray(res.json)) {
    throw new Error(`Discord メッセージ取得に失敗しました（HTTP ${res.code}）: ${mask(truncate(res.body, 300))}`);
  }

  return res.json.slice().sort((a, b) => cmpId(a.id, b.id));
}

/**
 * 報告候補かどうか。
 * 除外理由を返すのは、あとで「なぜ拾われなかったか」を追えるようにするため。
 */
export function classifyMessage(cfg, msg) {
  if (msg.author && msg.author.bot) return { target: false, reason: 'bot' };

  // system メッセージ（参加通知・ピン留め通知など）。0 = 通常, 19/21 = 返信系。
  const t = msg.type;
  if (t !== undefined && t !== 0 && t !== 19 && t !== 21) return { target: false, reason: 'system' };

  if (cfg.requireMention) {
    const mentioned = (msg.mentions || []).some((u) => u.id === cfg.botUserId);
    if (!mentioned) return { target: false, reason: 'no-mention' };
  }

  const body = stripNoise(msg.content);
  if (body) return { target: true, body };

  // 本文が無くても添付があれば報告。バグ報告ではスクリーンショットが本体になることがある。
  // 文字が無いので抽出はできないが、落とすほうが害が大きいので行だけ作る。
  if (attachmentUrls(msg).length) return { target: true, body: '', attachmentOnly: true };

  return { target: false, reason: 'empty' };
}

/** 添付ファイルのURL。スクリーンショットが報告の本体になる場合に使う。 */
export function attachmentUrls(msg) {
  return (msg.attachments || []).map((a) => a?.url).filter(Boolean);
}

/**
 * URL のみ・メンションのみのメッセージを弾くための下ごしらえ。
 * ピン留めした取り込みリンク自身がここで落ちる。
 */
export function stripNoise(content) {
  const s = normalizeText(content);
  if (!s) return '';
  const withoutUrls = s.replace(/https?:\/\/\S+/g, '').replace(/<@!?\d+>|<@&\d+>|<#\d+>/g, '').trim();
  if (!withoutUrls) return '';
  if (withoutUrls.length < 2) return '';
  return s;
}

/** すでに ✅ か ⚠️ を自分で付けているか（カーソルが主、これが副の二重ガード）。 */
export function alreadyHandled(msg) {
  for (const r of msg.reactions || []) {
    if (!r.me) continue;
    const name = r.emoji?.name || '';
    if (name === EMOJI.OK || name === EMOJI.RAW || name === EMOJI.RAW_FALLBACK) return true;
  }
  return false;
}

/** 自分がその絵文字を付けているか。残った ❓ を掃除する判断に使う。 */
export function hasOwnReaction(msg, emoji) {
  return (msg.reactions || []).some((r) => r.me && (r.emoji?.name || '') === emoji);
}

/**
 * リアクションを付ける。⚠️ は環境により VS16 付き／無しで受け付けが割れるため
 * 400 が返ったら異体字セレクタ無しで1回だけやり直す。
 */
export async function addReaction(cfg, messageId, emoji) {
  const put = (e) => discordFetch(
    cfg, 'PUT',
    `/channels/${cfg.channelId}/messages/${messageId}/reactions/${encodeURIComponent(e)}/@me`
  );
  let res = await put(emoji);
  if (res.code === 400 && emoji === EMOJI.RAW) res = await put(EMOJI.RAW_FALLBACK);
  if (res.code === 204 || res.code === 200) return { ok: true };
  return { ok: false, code: res.code, body: mask(truncate(res.body, 200)) };
}

export function removeOwnReaction(cfg, messageId, emoji) {
  return discordFetch(
    cfg, 'DELETE',
    `/channels/${cfg.channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`
  );
}

/** シートから1クリックで現場の文脈に飛べるリンク。 */
export function messageLink(cfg, messageId) {
  return `https://discord.com/channels/${cfg.guildId || '@me'}/${cfg.channelId}/${messageId}`;
}

/** 表示名。サーバーニックネーム → global_name → username の順。 */
export function authorName(msg) {
  if (msg.member?.nick) return msg.member.nick;
  const a = msg.author || {};
  return a.global_name || a.username || `unknown:${a.id || '?'}`;
}

/** Bot 自身の ID とチャンネルの所属サーバーを解決する。 */
export async function resolveIdentity(cfg) {
  const me = await discordFetch(cfg, 'GET', '/users/@me');
  if (me.code !== 200 || !me.json?.id) {
    throw new ConfigError(`Discord Bot トークンが不正です（HTTP ${me.code}）。`);
  }
  cfg.botUserId = me.json.id;

  const ch = await discordFetch(cfg, 'GET', `/channels/${cfg.channelId}`);
  if (ch.code !== 200 || !ch.json) {
    throw new ConfigError(`CHANNEL_ID のチャンネルを取得できません（HTTP ${ch.code}）。Bot がそのチャンネルを見られるか確認してください。`);
  }
  if (ch.json.guild_id) cfg.guildId = ch.json.guild_id;

  return { botUserId: cfg.botUserId, guildId: cfg.guildId, botName: me.json.username };
}

/**
 * ID を指定して1件だけ取り直す。
 * カーソルが追い越してしまった保留（❓）を呼び戻すために使う。
 * 消されていれば null（消えた投稿を追い続けない）。
 */
export async function fetchMessageById(cfg, messageId) {
  const res = await discordFetch(cfg, 'GET', `/channels/${cfg.channelId}/messages/${messageId}`);
  if (res.code === 404) return null;
  if (res.code !== 200 || !res.json) return null;
  return res.json;
}

/**
 * 自分が付けたリアクションを外す。
 * 保留が解決したときに ❓ を残さないため。権限は追加分だけで足りる（自分の分の削除）。
 * 外せなくても取り込みは続ける（見た目の問題であって記録は済んでいる）。
 */
export async function removeReaction(cfg, messageId, emoji) {
  const res = await discordFetch(
    cfg, 'DELETE',
    `/channels/${cfg.channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`
  );
  if (res.code === 204 || res.code === 200 || res.code === 404) return { ok: true };
  return { ok: false, code: res.code, body: mask(truncate(res.body, 200)) };
}

/** チャンネルの最新メッセージ ID（カーソル初期化用）。無ければ '0'。 */
export async function fetchLatestMessageId(cfg) {
  const res = await discordFetch(cfg, 'GET', `/channels/${cfg.channelId}/messages?limit=1`);
  if (res.code !== 200 || !Array.isArray(res.json)) {
    throw new Error(`最新メッセージの取得に失敗しました（HTTP ${res.code}）: ${mask(truncate(res.body, 300))}`);
  }
  return res.json.length ? res.json[0].id : '0';
}
