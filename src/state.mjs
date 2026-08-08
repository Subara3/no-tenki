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
  updatedAt: ''
};

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

/** カーソルは巻き戻さない。必ず大きい方を採る。 */
export function advanceCursor(state, id, maxIdFn) {
  if (!id) return;
  state.lastMessageId = maxIdFn(state.lastMessageId, String(id));
}
