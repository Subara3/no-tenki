# No転記

> ノー転記／ナンバー転記／のーてんき

Discordのチャンネルに溜まった投稿を、さくらのAI Engine で項目に分解して
Googleスプレッドシートに追記します。**書き写す作業が要らなくなる、という一点だけのツールです。**

Botは一言も喋りません。結果はリアクション3つだけで伝えます。

| | |
|---|---|
| ✅ | 記録した |
| ❓ | 読み取れなかった。書き直して投稿し直してください |
| ⚠️ | うまく読めなかったので、原文のまま残しました |

投稿する人は**普通に書くだけ**です。メンションもコマンドも要りません。

**常時監視も定期実行もしません。呼ばれたときだけ動きます。** 入口は3つ。

| 入口 | 誰が | いつ |
|---|---|---|
| **シートを開く** | 読む人 | 開いた瞬間に取り込みが始まる。読むときにデータが追いつく |
| **Discordのピン留めリンク** | いま記録したい投稿者 | 押した瞬間 |
| 手動実行（Actionsタブ） | 導入者 | デバッグ用 |

動いていないときのコストはゼロです。対象が0件なら、さくらのリクエストも消費しません。

---

## 何を集めるかは設定で決まる

このツールは「業務報告」専用ではありません。**集める対象と、シートの列を、設定で差し替えられます。**

| | 業務報告を集める | ゲームのテストプレイ報告を集める |
|---|---|---|
| `TOPIC` | `業務報告` | `ゲームのテストプレイで見つかった不具合・誤字・要望` |
| `CATEGORIES` | `progress,done,issue,other` | `バグ,誤字,バランス,要望,文書,その他` |
| `COLUMNS` | 省略（既定の並び） | `ID:autoid,種別:category,内容:summary,…` |

`COLUMNS` で列名と値の出どころを指定します。列の並びも中身も、集める対象に合わせて変えられます。

実際にこう入ります。

> 投稿：`セーブ画面でボタンを2回押すと落ちます。1回目は平気でした`

| ID | 種別 | 内容 | 発見者 | 報告日 | 発生Ver | ステータス |
|---|---|---|---|---|---|---|
| B-01 | バグ | セーブ画面でボタンを2回押すと落ちる。1回目は問題なし | （Discordの表示名） | 2026-08-06 | ver0.00.02 | 未対応 |

**1つの投稿に「1 …／2 …／3 …」と複数書かれていれば、項目ごとに別の行になります。**
番号を振って何件でも書いてもらえます。

`CATEGORIES` の**末尾の語が受け皿**になります（語彙に当てはまらないときここに寄せます）。
`その他` のような語を必ず最後に置いてください。

あいさつや相づちなど、対象について何も情報を含まない投稿は、**行も作らずリアクションも付けずに見送ります。**
「おつかれさまです」に ❓ が並ぶのを避けるためです。

---

## 用意するもの

| | 何を | どこで |
|---|---|---|
| 1 | Discord Bot のトークン | [Discord Developer Portal](https://discord.com/developers/applications) |
| 2 | さくらのAI Engine のAPIキー | [さくらのAI Engine](https://www.sakura.ad.jp/aipf/)（無償プランあり） |
| 3 | Googleスプレッドシート1枚 | Googleドライブ |

GitHub アカウントも要ります。**リポジトリは公開にしてください。** 公開リポジトリの Actions は
実行時間が無制限・無料で、アカウントの無料枠にも加算されません（非公開だと 2,000分/月 を消費します）。

---

## セットアップ

### 1. Discord Bot を作る

1. Developer Portal → **New Application**
2. **Bot** タブ → **Reset Token** → 出た文字列を控える
3. 同じページで **MESSAGE CONTENT INTENT** を **ON**（これが無いと本文が空で届きます）
4. **OAuth2 → URL Generator** → SCOPES は `bot`、権限は次の**3つだけ**
   - View Channels / Read Message History / Add Reactions
5. 生成URLを開いてサーバーに招待
6. 対象チャンネルを開き、アドレスバーの末尾の数字がチャンネルIDです
   `https://discord.com/channels/<サーバーID>/<チャンネルID>`

> **送信権限は付けません。** Botは喋らないので不要です。
> 万一トークンが漏れても、できるのは「読む」と「絵文字を付ける」だけです。

### 2. さくらのAI Engine のキーを取る

`uuid:シークレット` という形です。**コロンの前後をまとめて全部**控えてください。

### 3. GitHub のトークンを作る

シート側から取り込みを起動するために使います。
[Fine-grained token](https://github.com/settings/personal-access-tokens/new) を、
**このリポジトリだけ**に絞り、**Contents: Read and write** だけ付けてください。

### 4. シート側の受け口を置く

1. スプレッドシートを作り、**拡張機能 → Apps Script**
2. `sheet/Code.gs` の中身を貼り、`sheet/appsscript.json` の内容でマニフェストを置き換える
3. **プロジェクトの設定 → スクリプト プロパティ**に3つ追加

   | プロパティ | 値 |
   |---|---|
   | `SHEET_SECRET` | 好きな文字列（手順5で GitHub 側にも同じ値を入れる） |
   | `GITHUB_TOKEN` | 手順3のトークン |
   | `GITHUB_REPO` | `自分のアカウント名/no-tenki` |

4. **デプロイ → 新しいデプロイ → ウェブアプリ**（実行：自分／アクセス：全員）
5. エディタで **`checkGitHub` を実行**して承認を通す
   （`setupTrigger` は外部通信を使わないので、それだけでは通信の承認画面が出ません）
6. **`setupTrigger` を実行**。シートを開いたときの取り込みが設置され、
   ピン留め用URL（起動専用の鍵つき）がログに出ます

> ここに Discord トークンもさくらキーも置きません。
> ピン留めURLに載る `INGEST_KEY` と、行を書き込める `SHEET_SECRET` は**別の鍵**です。
> リンクが漏れても、できるのは取り込みを起動することだけです。

### 5. リポジトリを Fork して Secrets を入れる

```
gh secret set DISCORD_BOT_TOKEN --body '...'
gh secret set SAKURA_API_KEY    --body '...'
gh secret set CHANNEL_ID        --body '...'
gh secret set SHEET_WEBAPP_URL  --body '...'
gh secret set SHEET_SECRET      --body '...'   # 手順3と同じ値
```

集める対象は Secrets ではなく Variables に入れます（秘密ではないので）。
下はテストプレイのバグ報告を集める場合の例です。

```
gh variable set TOPIC      --body 'ゲームのテストプレイで見つかった不具合・誤字・要望'
gh variable set CATEGORIES --body 'バグ,誤字,バランス,要望,文書,その他'
gh variable set COLUMNS    --body 'ID:autoid,種別:category,内容:summary,発見者:author,報告日:date,発生Ver:version,ステータス:blank,備考:blank,Discordリンク:link,添付:attachments,原文:raw,状態:state,メッセージID:msgid'
gh variable set ID_PREFIX  --body '要望:R,*:B'
gh variable set SHEET_TAB  --body '書き込み先タブ名'
```

すでにある表に合わせて追記したい場合は、その表の書式を写せます。
色付きのドロップダウン（ステータスなど）はセルの背景ではないので、現物からコピーします。

```
gh variable set MIMIC_FROM_TAB  --body '手で作った既存タブ名'
gh variable set MIMIC_COLUMNS   --body 'ステータス'
gh variable set COLUMN_DEFAULTS --body 'ステータス:未対応'
```

バージョンの告知チャンネルがあるなら、`発生Ver` を投稿時刻から自動で決められます。

```
gh variable set VERSION_CHANNEL_ID --body '告知チャンネルのID'
```

### 6. Actions を有効化して、Discord にリンクを貼る

Actions タブから有効化し、`ingest` を一度手動実行してください。
**初回はカーソルを現在地に合わせて終了します**（過去ログを丸ごと取り込む事故を防ぐため）。
2回目以降が本番です。

最後に、手順4で出たピン留め用URLを Discord のチャンネルに貼ってピン留めします。
Botは送信権限を持たないので、ここだけ手でやります。

コピペ用:

```
📌 ここに普通に書いてください。メンションもコマンドも要りません。

▶ いますぐ記録する
（ここにURL）

付くリアクションの意味：
✅ 記録した
❓ 読み取れなかった。書き直して投稿し直してください
⚠️ うまく読めなかったので、原文のまま記録しました
```

URLだけの投稿は取り込み対象から自動的に外れるので、このメッセージ自体が記録されることはありません。

---

## 設定できるもの

| 名前 | 既定 | 説明 |
|---|---|---|
| `TOPIC` | `業務報告` | このチャンネルが何を集めているか |
| `CATEGORIES` | `progress,done,issue,other` | 種別の語彙。**末尾が受け皿** |
| `FIELDS` | `数値` | シートの列になる対象固有の項目（最大8個） |
| `MODEL` | `gpt-oss-120b` | 抽出に使うモデル |
| `MAX_BATCH` | `10` | 1回で束ねる最大件数 |
| `MAX_CHARS` | `1000` | 1投稿あたりの切り詰め文字数 |
| `MONTHLY_LIMIT` | `2700` | 月間のリクエスト自主上限 |
| `REQUIRE_MENTION` | `false` | `true` でBotへのメンション付きだけを対象に |
| `TIMEZONE` | `Asia/Tokyo` | 日付の基準 |

---

## 消費の考え方

**1回の取り込み＝さくら1リクエスト**です。最大10件をまとめて1つのプロンプトに束ね、
連番を振って配列で返させます。「ナンバー転記」の読みが指しているのがこの仕組みです。

対象が0件なら**さくらを呼びません**。上限は「シートを開いた回数＋リンクを押した回数」で、
常駐していないので暴走する経路が構造的にありません。

---

## 困ったとき

| 症状 | 見るところ |
|---|---|
| ✅ が付かない | カーソルより前の投稿は対象外です。`state.json` の `lastMessageId` を確認 |
| 本文が空で届く | MESSAGE CONTENT INTENT が OFF |
| リアクションが付かない | チャンネル権限で「リアクションの追加」を許可 |
| シートに入らない | `SHEET_SECRET` が GAS 側と GitHub 側で一致しているか |
| 列がずれると言われる | `FIELDS` を変えた後は、既存の月シートを別名にしてください |
| 全部 ⚠️ になる | エラーシートを確認。`max_tokens` で切れた場合は `MAX_BATCH` を下げる |
| リンクを押すと「起動できませんでした」 | GASエディタで `checkGitHub` を実行。トークンと承認を検査します |

### 鍵が漏れたとき

| | 手順 | 漏れて何ができるか |
|---|---|---|
| Discord トークン | Developer Portal → Bot → Reset Token → Secrets を更新 | 読む／絵文字を付ける、まで |
| さくらのキー | コントロールパネルで再発行 → Secrets を更新 | 無償プランは超過課金なし |
| GitHub トークン | 該当トークンを Revoke → 作り直して GAS のプロパティを更新 | 取り込みを起動できる、まで |
| ピン留めURL | GAS のプロパティから `INGEST_KEY` を消して `setupTrigger` を再実行 → 貼り直し | 取り込みを起動できる、まで |

`エラー` シートに、保留の理由・縮退の理由・原文・Discordリンクが残ります。
**❓ になった投稿も原文ごとここに残る**ので、消えることはありません。

---

## なぜ Google Apps Script ではないのか

最初は GAS だけで作ろうとして、**動かないことが実測で分かって捨てました。**

GAS から Discord の guild/channel 系エンドポイントを叩くと、Discord 本体に届く前に
Cloudflare のエッジで捨てられます。

```
GET /users/@me                  → 200  x-ratelimit-* あり（Discord本体に到達）
GET /channels/{id}/messages     → 403  {"code":40333}  x-ratelimit-* なし（エッジで遮断）
```

`x-ratelimit-*` の有無が決定的でした。原因は User-Agent です。**UrlFetchApp は
User-Agent の指定を受け付けず、必ず `Mozilla/5.0 (compatible; Google-Apps-Script; ...)` を送ります**
（3通りの指定で同一の値が送られることをエコーサービスで実測）。
Discord はブラウザ風UAの Bot リクエストを遮断します（[discord-api-docs#6473](https://github.com/discord/discord-api-docs/issues/6473)）。
GAS 側に変更手段がありません。

向きを逆にする案（Discord Interactions → GAS の doPost）も不可でした。
GAS のウェブアプリは POST に必ず 302 を返すため、Discord の Endpoint 検証を通せません。

同じ壁に当たった記録：[Google Apps Script Community](https://groups.google.com/g/google-apps-script-community/c/x6JmorR-Ufs) /
[Qiita](https://qiita.com/Aotumuri/items/e1e9d4c67048544a41d5)

GitHub Actions のランナーからは通ります（`200` / `x-ratelimit-limit: 5`）。
`.github/workflows/probe.yml` がその確認を1本で回せるようにしてあります。

---

## 開発

```
src/
  config.mjs    設定・既定値・マスク・Snowflake比較・日付
  index.mjs     ingest 本体
  discord.mjs   取得・対象判定・リアクション
  sakura.mjs    束ねプロンプト・パース・要素検証
  sink.mjs      シートへの書き出し
  state.mjs     カーソル・月間カウンタ
sheet/Code.gs   スプレッドシート側の受け口
test/
  harness.mjs        判定ロジックの検証（外部通信なし）
  probe-sakura.mjs   さくらの生の応答を見る調査用（1消費）
```

依存パッケージはありません（Node 20+ の組み込み `fetch` のみ）。

```
node test/harness.mjs
```

`test/fixtures/bundle-response.json` は、gpt-oss-120b が実際に10件束ねに返した応答そのものです。

**ログに投稿本文を出しません。** 公開リポジトリなので Actions のログは誰でも読めます。
出力するのは件数と内訳だけです（`2件処理：✅1 ❓0 ⚠️0`）。

---

## 名前について

**No転記**。読み方は3つあり、どれで読んでも当たっています。

| 読み | 意味 |
|---|---|
| ノー転記 | 書き写す作業が消える、というこのツールの機能そのもの |
| ナンバー転記 | `No.` は番号。束ねた投稿に連番を振って1リクエストで処理する中核の仕組み |
| のーてんき | 呼ばれるまで何もしない。対象が無ければ何も消費しない |

---

## ライセンス

MIT
