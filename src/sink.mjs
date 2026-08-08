/**
 * sink.mjs — スプレッドシートへの書き出し口
 *
 * シートに紐づいた Apps Script（sheet/Code.gs）へ HTTPS POST する。
 * 送るのは行データだけ。Discord トークンもさくらキーも Google 側には渡らない。
 *
 * GAS のウェブアプリは POST に 302 を返すが、Node の fetch は既定でリダイレクトを追うので問題にならない。
 * （この 302 こそ、Discord の Interactions Endpoint に GAS を使えなかった理由でもある）
 */

import { mask, truncate } from './config.mjs';

/**
 * @param {object} cfg
 * @param {object} payload { tab, headers, idPrefix, reportRows, usageRow, errorRows }
 */
export async function pushToSheet(cfg, payload) {
  if (!cfg.sheetUrl) {
    return { ok: false, skipped: true, reason: 'SHEET_WEBAPP_URL が未設定のためシートへの書き出しをとばしました' };
  }

  const body = JSON.stringify({ secret: cfg.sheetSecret, ...payload });

  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(cfg.sheetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        redirect: 'follow',
        signal: AbortSignal.timeout(60000)
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* HTML が返ることがある */ }

      if (res.ok && json?.ok) return { ok: true, appended: json.appended ?? 0 };

      last = `HTTP ${res.status} ${mask(truncate(json ? JSON.stringify(json) : text, 200))}`;
    } catch (e) {
      last = mask(e);
    }
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }
  return { ok: false, reason: last };
}
