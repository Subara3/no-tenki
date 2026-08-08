/**
 * version.mjs — バージョン年表
 *
 * 「発生Ver」を人に書かせない仕組み。
 * 配布告知のチャンネル（例：ゲームデータ置き場）に ver が日時つきで投稿されているので、
 * 報告の投稿時刻がどの ver の期間に入るかで決める。
 *
 * 報告チャンネルのログだけでは分からないが、告知チャンネルを一緒に読めば分かる。
 */

import { discordFetch } from './discord.mjs';
import { cmpId } from './config.mjs';

// ver0.00.02 / v1.2 / ver 0.3.1 などを拾う。数字とドットが2つ以上続くものだけ。
const VER = /\bv(?:er)?\s*\.?\s*(\d+(?:\.\d+)+)/i;

/**
 * 告知チャンネルから年表を作る。
 * @returns {Promise<Array<{version:string, at:number, messageId:string}>>} 時刻の昇順
 */
export async function buildVersionTimeline(cfg) {
  if (!cfg.versionChannelId) return [];

  const res = await discordFetch(cfg, 'GET', `/channels/${cfg.versionChannelId}/messages?limit=100`);
  if (res.code !== 200 || !Array.isArray(res.json)) {
    // 年表が作れなくても取り込み自体は続ける。発生Ver が空欄になるだけ。
    // 誤った ver を入れるより、空欄のほうが安全（人が見て気づける）。
    return [];
  }

  return timelineFromMessages(res.json);
}

/**
 * メッセージ配列から年表を作る純粋関数。通信しないのでテストできる。
 * @param {Array<{id:string, timestamp:string, content:string}>} messages
 */
export function timelineFromMessages(messages) {
  const timeline = [];
  for (const m of messages || []) {
    if (!m?.content) continue;
    const hit = String(m.content).match(VER);
    if (!hit) continue;
    const at = Date.parse(m.timestamp);
    if (isNaN(at)) continue;
    timeline.push({ version: `ver${hit[1]}`, at, messageId: m.id });
  }

  timeline.sort((a, b) => (a.at - b.at) || cmpId(a.messageId, b.messageId));

  // 同じ ver が複数回告知されることがある（差分版の再配布など）。最初の告知を採用する。
  const seen = new Set();
  return timeline.filter((e) => {
    if (seen.has(e.version)) return false;
    seen.add(e.version);
    return true;
  });
}

/**
 * その時刻に配布されていた ver を返す。
 * 最初の告知より前の報告は、対応する ver が無いので空文字。
 */
export function versionAt(timeline, isoOrMs) {
  if (!timeline.length) return '';
  const t = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
  if (isNaN(t)) return '';
  let found = '';
  for (const e of timeline) {
    if (e.at <= t) found = e.version;
    else break;
  }
  return found;
}
