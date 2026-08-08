/**
 * probe-sakura.mjs — さくらの生の応答を見るための調査用スクリプト。
 * 応答がパースできなかったときに、推測ではなく現物を見るために使う。
 *
 *   node test/probe-sakura.mjs
 *
 * 1リクエスト消費する。CI では動かさない。
 */

import { loadConfig } from '../src/config.mjs';
import { buildSystemPrompt, buildUserPrompt } from '../src/sakura.mjs';

const cfg = loadConfig();

// 調査用の作り物。実際の投稿は入れない（公開リポジトリなので）。
const reports = [
  { idx: 1, text: 'セーブ画面でボタンを2回押すと落ちます。1回目は平気でした', postedAt: '2026-08-06' },
  { idx: 2, text: '<@&000000000000000000> テスト', postedAt: '2026-08-06' }
];

const payload = {
  model: cfg.model,
  messages: [
    { role: 'system', content: buildSystemPrompt(cfg, reports.length) },
    { role: 'user', content: buildUserPrompt(cfg, reports) }
  ],
  temperature: 0,
  max_tokens: Math.min(4000, 400 + reports.length * 300)
};

console.log('max_tokens:', payload.max_tokens);

const res = await fetch(cfg.endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.sakuraKey}` },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(120000)
});

const json = await res.json();
console.log('HTTP', res.status);
console.log('finish_reason:', json?.choices?.[0]?.finish_reason);
console.log('usage:', JSON.stringify(json?.usage));
console.log('--- content ---');
console.log(JSON.stringify(json?.choices?.[0]?.message?.content));
