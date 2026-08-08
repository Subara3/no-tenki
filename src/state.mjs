/**
 * state.mjs — カーソルと月間カウンタ
 *
 * v3 では Script Properties に置いていたもの。リポジトリ内の state.json に移し、
 * ワークフローが実行のたびに commit する。
 *
 * state.json に秘密は一切入らない（入るのはメッセージIDと回数だけ）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { monthKey } from './config.mjs';

const FILE = path.resolve(process.cwd(), 'state.json');

const EMPTY = {
  lastMessageId: '',
  monthKey: '',
  monthCount: 0,
  // 保留（❓）になった投稿の再試行台帳。{ メッセージID: 試した回数 }
  // カーソルは保留を追い越すので、これが無いと二度と拾われない。
  holds: {},
  updatedAt: ''
};

/** 保留を何回まで試すか。無条件に試し続けるとさくらの枠を毎回1つ溶かす。 */
export const HOLD_MAX_ATTEMPTS = 3;

export function loadState() {
  let raw;
  try {
    raw = fs.readFileSync(FILE, 'utf8');
  } catch {
    return { ...EMPTY };   // 初回。ファイルが無いのは正常
  }
  try {
    // Windows のエディタが付ける BOM を許容する。
    // 壊れた state を「初回」と誤認すると過去ログを取り込みに行くので、ここは黙って落とさない。
    return { ...EMPTY, ...JSON.parse(raw.replace(/^\uFEFF/, '')) };
  } catch (e) {
    throw new Error(`state.json が壊れています。手で直すか削除してください: ${e.message}`);
  }
}

export function saveState(state) {
  const out = { ...state, updatedAt: new Date().toISOString() };
  fs.writeFileSync(FILE, JSON.stringify(out, null, 2) + '\n', 'utf8');
  return out;
}

/**
 * 月が変わっていたらカウンタを戻す。
 * 戻す前の値を返すので、呼び出し側が月次サマリをシートへ送れる。
 */
export function rollMonth(state, cfg, now = new Date()) {
  const current = monthKey(now, cfg.timezone);
  if (state.monthKey === current) return { rolled: false, previous: null };

  const previous = state.monthKey
    ? { monthKey: state.monthKey, monthCount: state.monthCount }
    : null;

  state.monthKey = current;
  state.monthCount = 0;
  return { rolled: true, previous };
}

/** 残り枠。fail-closed の判定材料。 */
export function budgetStatus(state, cfg) {
  const used = Number(state.monthCount) || 0;
  return {
    used,
    limit: cfg.monthlyLimit,
    remaining: Math.max(0, cfg.monthlyLimit - used),
    exhausted: used >= cfg.monthlyLimit
  };
}

/** さくらを呼ぶ直前に1つ消費する。枠が無ければ false（呼ばない）。 */
export function consumeOne(state, cfg) {
  const st = budgetStatus(state, cfg);
  if (st.exhausted) return false;
  state.monthCount = st.used + 1;
  return true;
}

/**
 * 再試行の対象になっている保留の ID を古い順で返す。
 * 上限に達したものは呼び出し側で諦めさせる（ここでは落とさない）。
 */
export function pendingHoldIds(state) {
  const holds = state.holds && typeof state.holds === 'object' ? state.holds : {};
  return Object.keys(holds).sort((a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 取り込みの結果を台帳に反映する。
 * @param {object} state
 * @param {string[]} heldIds     今回 ❓ になった投稿
 * @param {string[]} settledIds  今回 ✅／⚠️／見送りで決着した投稿
 * @returns {{giveUp: string[]}} 上限に達して諦めた ID
 */
export function updateHolds(state, heldIds, settledIds) {
  if (!state.holds || typeof state.holds !== 'object') state.holds = {};
  const giveUp = [];

  for (const id of settledIds) delete state.holds[String(id)];

  for (const id of heldIds) {
    const key = String(id);
    const n = (Number(state.holds[key]) || 0) + 1;
    if (n >= HOLD_MAX_ATTEMPTS) {
      delete state.holds[key];
      giveUp.push(key);
    } else {
      state.holds[key] = n;
    }
  }
  return { giveUp };
}

/** カーソルは巻き戻さない。必ず大きい方を採る。 */
export function advanceCursor(state, id, maxIdFn) {
  if (!id) return;
  state.lastMessageId = maxIdFn(state.lastMessageId, String(id));
}
