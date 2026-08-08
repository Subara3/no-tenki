/**
 * index.mjs — ingest 本体
 *
 * 公開リポジトリで動く。Actions のログは誰でも読める。
 * したがって報告本文・報告者名・要約をログに出してはいけない。出すのは件数と内訳だけ。
 */

import fs from 'node:fs';
import { loadConfig, ConfigError, EMOJI, maxId, dateKey, monthKey, normalizeText, truncate, mask, reportHeaders } from './config.mjs';
import { fetchMessagesAfter, classifyMessage, alreadyHandled, addReaction, removeReaction, hasOwnReaction, fetchMessageById, messageLink, authorName, resolveIdentity, fetchLatestMessageId, sleep, attachmentUrls } from './discord.mjs';
import { buildVersionTimeline, versionAt } from './version.mjs';
import { extractBundle, validateItem, groupByIdx } from './sakura.mjs';
import { loadState, saveState, rollMonth, budgetStatus, consumeOne, advanceCursor, pendingHoldIds, updateHolds, HOLD_MAX_ATTEMPTS } from './state.mjs';
import { pushToSheet } from './sink.mjs';

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const CHECK = args.has('--check');

function log(...a) { console.log(...a); }

/**
 * どの入口から呼ばれたか。使用量シートに残す。
 * 「常駐ゼロのツールは実際どう呼ばれるのか」は、このツールで一番知りたい数字なので必ず記録する。
 */
function entrySource() {
  const ev = process.env.GITHUB_EVENT_NAME;
  // 定期実行。ここを落としていたせいで、Actions 上の schedule が
  // 全部 "cli" として記録されていた。実際には8割がこの経路だったのに、
  // 使用量シートを見ても分からない状態になっていた。
  if (ev === 'schedule') return 'schedule';
  if (ev === 'workflow_dispatch') return 'manual';
  if (ev === 'repository_dispatch') {
    // シート側が client_payload.source に "sheet"（onOpen）か "link"（ピン留め）を入れてくる
    try {
      const payload = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
      const s = payload?.client_payload?.source;
      if (s === 'sheet' || s === 'link') return s;
    } catch { /* 読めなければ下の既定へ */ }
    return 'dispatch';
  }
  // 知らないイベントは名前をそのまま残す。"cli" は手元で直接動かしたときだけ。
  return ev || 'cli';
}

async function main() {
  const cfg = loadConfig();
  const state = loadState();

  const who = await resolveIdentity(cfg);
  log(`Bot: ${who.botName} / サーバー: ${who.guildId ? '解決済み' : '未解決'}`);

  if (CHECK) return selfCheck(cfg, state);

  // 月替わり。カウンタを戻す前に先月の実績を控える。
  const roll = rollMonth(state, cfg);
  const pendingSummary = roll.previous;

  // 初回：カーソルが無ければ現在位置に合わせて終了する。
  // 何年ぶんもの過去ログが初回に襲ってきて枠を溶かす事故を防ぐ。
  if (!state.lastMessageId) {
    state.lastMessageId = await fetchLatestMessageId(cfg);
    saveState(state);
    log('初回起動：カーソルを現在地に設定しました。次回以降の投稿が対象になります。');
    return;
  }

  // 保留（❓）はカーソルが追い越すので、ID を指定して呼び戻す。
  // これが無いと、語彙や設定を直しても過去の保留は永久に拾われない。
  const retried = await collectHolds(cfg, state);

  const fetched = await fetchMessagesAfter(cfg, state.lastMessageId, 100);
  if (!fetched.length && !retried.length) {
    log('新着はありませんでした。');
    saveState(state);
    return;
  }

  // 保留の再試行を先に置く。束ね上限に押し出されて先送りになり続けるのを避ける。
  const targets = retried.map(({ msg, body, attachmentOnly }) => ({
    pos: null, msg, body, attachmentOnly, retried: true
  }));
  // 再試行で拾った投稿がカーソルより後ろにも居ることがある（前回カーソルが進まなかった場合）。
  // 両方から入れると同じ投稿で2行できるので、ここで弾く。
  const retriedIds = new Set(retried.map(({ msg }) => String(msg.id)));
  fetched.forEach((m, pos) => {
    if (retriedIds.has(String(m.id))) return;
    const c = classifyMessage(cfg, m);
    if (!c.target) return;
    if (alreadyHandled(m)) return;
    targets.push({ pos, msg: m, body: c.body, attachmentOnly: !!c.attachmentOnly, retried: false });
  });

  if (retried.length) log(`保留の再試行 ${retried.length}件を対象に戻しました。`);

  if (!targets.length) {
    // 対象ゼロでも読み終わった区間ぶんカーソルは進める。
    // Bot 発言や URL だけの投稿が並んだ区間で毎回同じ100件を読み直さないため。
    advanceCursor(state, fetched[fetched.length - 1].id, maxId);
    saveState(state);
    log(`新しい報告はありませんでした（${fetched.length}件を確認）。`);
    return;
  }

  const batch = targets.slice(0, cfg.maxBatch);
  const carriedOver = targets.length - batch.length;

  // 発生Ver は告知チャンネルの年表から決める。人に書かせない。
  // 年表が作れなくても取り込みは続ける（空欄が「手で入れて」の合図になる）。
  const timeline = await buildVersionTimeline(cfg);

  const entries = batch.map((b) => ({
    messageId: b.msg.id,
    author: authorName(b.msg),
    postedAt: dateKey(new Date(b.msg.timestamp), cfg.timezone),
    version: versionAt(timeline, b.msg.timestamp),
    attachments: attachmentUrls(b.msg),
    text: normalizeText(b.body),
    imageOnly: b.attachmentOnly
  }));

  // 添付だけの投稿はさくらに渡さない。文字が無いので抽出しようがなく、
  // 束ねの枠を1つ潰すだけ無駄になる。行だけ作って人に見てもらう。
  const imageOnly = entries.filter((e) => e.imageOnly);
  const reports = entries.filter((e) => !e.imageOnly).map((e, i) => ({ ...e, idx: i + 1 }));

  if (DRY_RUN) {
    log(`[dry-run] 対象 ${targets.length}件、うち今回処理する ${entries.length}件。さくらは呼びません。`);
    log(`[dry-run] 本文つき ${reports.length}件（文字数: ${reports.map((r) => r.text.length).join(', ') || 'なし'}）`);
    log(`[dry-run] 添付のみ ${imageOnly.length}件`);
    if (timeline.length) {
      log(`[dry-run] バージョン年表: ${timeline.map((e) => e.version).join(' → ')}`);
      log(`[dry-run] 各件の発生Ver: ${entries.map((e) => e.version || '(空)').join(', ')}`);
    } else if (cfg.versionChannelId) {
      log('[dry-run] バージョン年表が空です。告知チャンネルの書式を確認してください。');
    }
    return;
  }

  let bundle = null;
  let bundleError = null;
  let outcome = { reportRows: [], errorRows: [], reactions: [], counts: zeroCounts() };

  // 本文つきが1件も無ければ、さくらを呼ばない（消費もしない）。
  if (reports.length) {
    const budget = budgetStatus(state, cfg);
    if (budget.exhausted) {
      log(`今月の枠を使い切りました（${budget.used}/${budget.limit}）。取り込みません。`);
      saveState(state);
      return;
    }
    consumeOne(state, cfg);   // 呼ぶ直前に数える

    try {
      bundle = await extractBundle(cfg, reports);
    } catch (err) {
      if (err instanceof ConfigError) throw err;   // キー不正などは fail-closed
      bundleError = err;                            // 全体パース不能 → 全件縮退
    }

    outcome = bundleError
      ? degradeAll(cfg, reports, bundleError)
      : dispatch(cfg, reports, bundle);
  }

  // 添付のみの分を足す。抽出はしていないので状態で明示する。
  for (const e of imageOnly) {
    outcome.reportRows.push(buildRow(cfg, e, { state: '画像のみ' }));
    outcome.reactions.push({ messageId: e.messageId, emoji: EMOJI.OK });
    outcome.counts.ok += 1;
    outcome.counts.rows += 1;
  }

  // シートへ。行データだけを渡す。
  const sink = await pushToSheet(cfg, {
    // SHEET_TAB が指定されていれば常にそのタブ。バグ一覧のように月で切ると使えない表のため。
    tab: cfg.sheetTab || monthKey(new Date(), cfg.timezone),
    headers: reportHeaders(cfg),
    idPrefix: cfg.idPrefix,
    mimicFrom: cfg.mimicFrom,
    mimicColumns: cfg.mimicColumns,
    columnDefaults: cfg.columnDefaults,
    reportRows: outcome.reportRows,
    errorRows: outcome.errorRows.concat(pendingSummary
      ? [[null, '月次', '', `${pendingSummary.monthKey} の消費は ${pendingSummary.monthCount} リクエストでした`, '', '']]
      : []),
    usageRow: [
      null, 'ingest', entrySource(), entries.length,
      outcome.counts.ok, outcome.counts.hold, outcome.counts.raw, outcome.counts.skip,
      bundleError ? `${cfg.model}(失敗)` : (bundle?.model ?? '(呼ばず)'),
      bundle?.ms ?? 0,
      bundleError ? mask(truncate(String(bundleError.message), 200))
        : (imageOnly.length ? `添付のみ ${imageOnly.length}件` : '')
    ]
  });

  // ✅ は「シートに入った」という意味。書けていないのに付けたら嘘になる。
  // 書き出しに失敗したら、リアクションを付けず、カーソルも進めずに落とす。
  // 月間カウンタだけは保存する（さくらは既に消費しているので、数えないと帳尻が合わない）。
  if (!sink.ok && !sink.skipped && outcome.reportRows.length) {
    saveState(state);
    log(`シートへの書き出しに失敗しました: ${sink.reason || '原因不明'}`);
    log('リアクションは付けず、カーソルも進めていません。原因を直してもう一度実行してください。');
    process.exitCode = 1;
    return;
  }

  if (sink.skipped) log(sink.reason);
  else if (sink.ok) log(`シートに ${sink.appended} 行追記しました。`);

  // リアクション。ここまで来ていれば行は書けている。
  // 絵文字が付かなかっただけなら記録を残して続ける（行の重複より軽い）。
  for (const r of outcome.reactions) {
    const res = await addReaction(cfg, r.messageId, r.emoji);
    if (!res.ok) log(`リアクション失敗（HTTP ${res.code}）`);
    await sleep(300);   // 1リクエスト/250ms の絞りに合わせる
  }

  // 保留の台帳を更新する。
  // ❓ が付いたまま解決した投稿は ❓ を外す（残すと「未解決」に見え続ける）。
  const heldNow = new Set(
    outcome.reactions.filter((r) => r.emoji === EMOJI.HOLD).map((r) => String(r.messageId))
  );
  const inBatch = batch.map((b) => String(b.msg.id));
  const settled = inBatch.filter((id) => !heldNow.has(id));
  const { giveUp } = updateHolds(state, [...heldNow], settled);

  // 決着した投稿に ❓ が残っていたら外す。再試行経路に限らない
  // （カーソルを戻して回収した場合も ❓ が残る）。付いているものだけ叩く。
  for (const b of batch) {
    const id = String(b.msg.id);
    if (heldNow.has(id)) continue;
    if (!hasOwnReaction(b.msg, EMOJI.HOLD)) continue;
    await removeReaction(cfg, id, EMOJI.HOLD);
    await sleep(300);
  }

  for (const id of giveUp) {
    log(`❓ のまま ${HOLD_MAX_ATTEMPTS} 回試したので再試行をやめます: ${messageLink(cfg, id)}`);
  }

  // カーソルは「処理し終えた最後のメッセージ」まで。
  // 取得した全件の最大IDまで進めると、束ね上限を超えたぶんを読み飛ばす。
  // 再試行ぶん（pos が null）はカーソルの外側にいるので数に入れない。
  const advanced = batch.filter((b) => b.pos !== null);
  if (advanced.length) {
    advanceCursor(state, fetched[advanced[advanced.length - 1].pos].id, maxId);
  }
  saveState(state);

  log(`投稿${entries.length}件 → ${outcome.counts.rows}行：` +
    `✅${outcome.counts.ok} ❓${outcome.counts.hold} ⚠️${outcome.counts.raw}` +
    (outcome.counts.skip ? `（報告以外 ${outcome.counts.skip}件は見送り）` : '') +
    (imageOnly.length ? `（うち添付のみ ${imageOnly.length}件）` : ''));
  if (carriedOver > 0) log(`他に ${carriedOver} 件残っています。次回の実行で続きを取り込みます。`);
  log(`今月の消費: ${state.monthCount}/${cfg.monthlyLimit}`);
}

/**
 * 台帳に載っている保留を ID 指定で取り直す。
 * 消えた投稿・対象外になった投稿は台帳から落とす（永久に追いかけない）。
 * @returns {Promise<Array<{msg:object, body:string, attachmentOnly:boolean}>>}
 */
async function collectHolds(cfg, state) {
  const ids = pendingHoldIds(state);
  if (!ids.length) return [];

  const out = [];
  const drop = [];
  for (const id of ids) {
    const msg = await fetchMessageById(cfg, id);
    if (!msg) { drop.push(id); continue; }          // 消された
    const c = classifyMessage(cfg, msg);
    if (!c.target) { drop.push(id); continue; }     // 対象外に変わった

    // すでに ✅／⚠️ が付いている＝別の経路で決着している。
    // もう一度渡すと同じ投稿で行が二重になる。残った ❓ だけ外して台帳から下ろす。
    if (alreadyHandled(msg)) {
      drop.push(id);
      if (hasOwnReaction(msg, EMOJI.HOLD)) {
        await removeReaction(cfg, id, EMOJI.HOLD);
        await sleep(300);
      }
      continue;
    }
    out.push({ msg, body: c.body, attachmentOnly: !!c.attachmentOnly });
  }
  if (drop.length) updateHolds(state, [], drop);
  return out;
}

// ok/hold/raw/skip は投稿の数、rows は作られた行の数。
// 1投稿から複数行が出るので、この2つは一致しない。
function zeroCounts() { return { ok: 0, hold: 0, raw: 0, skip: 0, rows: 0 }; }

/**
 * 列定義（cfg.columns）に沿って1行を組む。reportHeaders() と一対一。
 * @param r 投稿側の情報（author / postedAt / version / attachments / text / messageId）
 * @param v さくら側の結果。縮退や画像のみのときは state だけ入った擬似オブジェクト
 */
function buildRow(cfg, r, v) {
  return cfg.columns.map((c) => {
    switch (c.source) {
      case 'recordedat': return null;                            // 日時はシート側で打つ
      case 'autoid': return '';                                  // 採番はシート側（次の番号を知っているのはあちら）
      case 'blank': return '';                                   // 人が埋める欄
      case 'category': return v.category || '';
      case 'summary': return v.summary || '';
      case 'field': return v.fields?.[c.name] ?? '';
      case 'author': return r.author;
      case 'date': return v.date || r.postedAt;
      case 'version': return r.version || '';
      case 'attachments': return (r.attachments || []).join('\n');
      case 'link': return messageLink(cfg, r.messageId);
      case 'raw': return truncate(r.text, 2000);
      case 'state': return v.state || 'ok';
      case 'msgid': return r.messageId;
      default: return '';
    }
  });
}

function rawRow(cfg, r, note) {
  return buildRow(cfg, r, { state: `未解析${note ? `（${note}）` : ''}` });
}

/**
 * さくらの応答を投稿ごとに検証して行とリアクションに割り振る。
 *
 * 1つの投稿から複数の行が出ることがある（「1 …／2 …／3 …」と列挙された報告）。
 * 行は指摘の数だけ作るが、**リアクションは投稿に1つ**なので、投稿単位でまとめて決める。
 *   1行でも書けた         → ✅（記録された、が真になる）
 *   1行も書けず保留がある → ❓（書き直して再投稿）
 *   それ以外（型崩れ）     → ⚠️
 *   全部が対象外          → 何も付けない
 */
function dispatch(cfg, reports, bundle) {
  const byIdx = groupByIdx(bundle.items);
  const reportRows = [];
  const errorRows = [];
  const reactions = [];
  const counts = zeroCounts();

  for (const r of reports) {
    const items = byIdx[r.idx] || [];
    const results = items.length
      ? items.map((it) => validateItem(cfg, it, r, reports))
      : [{ status: 'raw', note: `idx ${r.idx} の要素が応答にありません` }];

    let wrote = 0;
    let held = 0;
    let degraded = 0;

    for (const v of results) {
      if (v.status === 'skip') continue;
      if (v.status === 'ok') {
        reportRows.push(buildRow(cfg, r, v));
        wrote += 1;
      } else if (v.status === 'hold') {
        held += 1;
        errorRows.push([null, '保留', r.messageId, v.note, truncate(r.text, 1000), messageLink(cfg, r.messageId)]);
      } else {
        reportRows.push(rawRow(cfg, r, v.note));
        wrote += 1;
        degraded += 1;
        errorRows.push([null, '縮退', r.messageId, v.note, truncate(r.text, 1000), messageLink(cfg, r.messageId)]);
      }
    }

    // 一部だけ保留になった投稿は、書けた行があるので ✅ にする。
    // 落ちた指摘はエラーシートに残るので、消えたことにはならない。
    if (wrote > 0) {
      counts.rows += wrote;
      const allDegraded = degraded === wrote;
      if (allDegraded) counts.raw += 1; else counts.ok += 1;
      reactions.push({ messageId: r.messageId, emoji: allDegraded ? EMOJI.RAW : EMOJI.OK });
    } else if (held > 0) {
      counts.hold += 1;
      reactions.push({ messageId: r.messageId, emoji: EMOJI.HOLD });
    } else {
      counts.skip += 1;   // 行も作らず、リアクションも付けない
      // 「見送った」ことは残す。リアクションも行も無いので、
      // ここに書かないと判断そのものが追えなくなる（拾えていない事故と区別が付かない）。
      errorRows.push([null, '見送り', r.messageId, '報告以外と判定', truncate(r.text, 300), messageLink(cfg, r.messageId)]);
    }
  }
  return { reportRows, errorRows, reactions, counts };
}

/** 応答全体がパース不能・API 失敗 → 全件を原文のまま記録して ⚠️。 */
function degradeAll(cfg, reports, err) {
  const note = mask(truncate(String(err?.message ?? err), 120));
  return {
    reportRows: reports.map((r) => rawRow(cfg, r, '応答不良')),
    errorRows: [[null, '全件縮退', '', `${note} / 対象${reports.length}件`, '', '']],
    reactions: reports.map((r) => ({ messageId: r.messageId, emoji: EMOJI.RAW })),
    counts: { ok: 0, hold: 0, raw: reports.length, skip: 0, rows: reports.length }
  };
}

/** --check：消費ゼロで通る範囲の自己診断。さくらだけは1消費する。 */
async function selfCheck(cfg, state) {
  const lines = [];
  lines.push(`OK  1. Discord トークン`);
  lines.push(`OK  2. チャンネル閲覧（サーバー ${cfg.guildId ? '解決済み' : '未解決'}）`);

  const recent = await fetchMessagesAfter(cfg, '0', 5).catch(() => null);
  if (!recent) lines.push('NG  3. メッセージ履歴を読めません');
  else {
    const human = recent.filter((m) => m.author && !m.author.bot);
    if (!human.length) lines.push('--  3. MESSAGE CONTENT INTENT：人間の投稿が無く判定できません');
    else if (human.every((m) => !m.content)) lines.push('NG  3. MESSAGE CONTENT INTENT が無効です');
    else lines.push('OK  3. MESSAGE CONTENT INTENT（本文が読めています）');
  }

  const b = budgetStatus(state, cfg);
  lines.push(`OK  4. 月間枠 ${b.used}/${b.limit}`);
  lines.push(state.lastMessageId ? `OK  5. カーソル設定済み` : '--  5. カーソル未設定（次回の実行で現在地に合わせます）');
  lines.push(cfg.sheetUrl ? 'OK  6. SHEET_WEBAPP_URL 設定済み' : 'NG  6. SHEET_WEBAPP_URL が未設定');

  log(lines.join('\n'));
}

main().catch((e) => {
  console.error(mask(e?.stack || e));
  process.exit(1);
});
