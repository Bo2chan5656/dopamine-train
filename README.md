# Dopamine Train

ダンベルのレップをこなさないと **YouTube Shorts** を送れなくする Chrome 拡張。
PC内蔵カメラでレップを検知し、視聴クレジットで再生とスクロールをゲートする。

既定は **1レップ = 1スライド**（`per-slide`: 1回挙げたら次のショートに送られて30秒見られる）。
設定でバンキング方式（`bank`: N レップ → X 秒。スライドは自分で送る）に切り替えられる。

> 開発初期はローカル動画の自前縦型プレイヤーを対象にしていたが、**YouTube Shorts に
> 一本化して削除した**（`src/player/`, `src/slider/local-player-slider.ts`,
> `src/slider/noop-slider.ts`, `src/main.ts`）。自前プレイヤーを
> 「Shorts と同型の縦積み + scrollIntoView」構造で作っておいたおかげで、
> `core/` は per-slide 分岐と `maxTickDtMs` の2箇所を足すだけで移行できている。

設計の詳細は実装計画（`/Users/bocchan/.claude/plans/tl-dr-cached-kay.md`）を参照。

## セットアップと実行

### 1. 依存のインストール

```bash
npm install
```

`.npmrc` の `legacy-peer-deps=true` が効いていれば `dependencies` の4つ
（TensorFlow.js 関連）以外は入らない。`node_modules` が数百MBに膨らんでいたら
効いていない証拠なので、`@mediapipe/pose`（約50MB）等の未使用パッケージが
紛れ込んでいないか確認する。

### 2. ビルド

```bash
npm run build:ext
```

`dist-extension/` が出力される。**コードを変えたときは毎回これを実行する。**

### 3. Chrome に読み込む

1. Chrome で `chrome://extensions` を開く
2. 右上の **デベロッパーモード** を ON
3. 左上の **「パッケージ化されていない拡張機能を読み込む」** をクリック
4. `dist-extension` フォルダを選ぶ

```
/Users/bocchan/Documents/dopamine train/dist-extension
```

> フォルダ**そのもの**を選ぶ（中の `manifest.json` を選ぶのではない）。

**アイコンをピン留めする**: manifest にアイコン画像を入れていないので、ツールバーでは
パズルピースのアイコン（拡張機能メニュー）の中に隠れている。それを開いて
「Dopamine Train」のピンをクリックして常時表示にしておく。

### 4. 使う

1. `https://www.youtube.com/shorts` を開く
2. ツールバーの **Dopamine Train のアイコンをクリック** → トレーナーウィンドウが
   別ウィンドウ（560×900）で開く
3. カメラ許可を求められたら **許可**
4. キャリブレーション: **右腕**、Mac を**横45度**に置いて**1.5〜2m** 離れる →
   「開始」→ 腕を伸ばし切って1秒 → 「腕を巻き上げて記録開始」→ 巻き上げて1秒
5. 完了後、**1回カールするごとに次のショートに送られて30秒見られる**

トレーナーウィンドウと YouTube を**左右に並べて使う構成**になる。カメラは Shorts の
タブ側では動かせない（拡張の offscreen / action popup / side panel からはカメラ許可
プロンプトが出せない: crbug 1214847 / 1339382）ため、独立ウィンドウの拡張ページが必須。

**設定変更**（1レップ何秒か、バンキング方式に変えるか、日次上限など）はトレーナー
ウィンドウの「報酬設定」パネルから、リビルドなしで即座に反映される。

### カメラなしで先に動作確認する

トレーナーの URL 末尾に `?source=keyboard` を付けて開くと、`j` = 有効レップ /
`k` = 無効レップ のキーボード入力になる（トレーナーウィンドウにフォーカスした状態で押す）。
拡張の ID は `chrome://extensions` で確認する。

```
chrome-extension://<拡張のID>/trainer.html?source=keyboard
```

### コードを変えたとき

```bash
npm run build:ext
```

そのあと `chrome://extensions` で Dopamine Train の**リロードボタン（🔄）**をクリック。
content script（`extension/content/`）を変えた場合は YouTube のタブも再読み込みする
（忘れても `background.ts` が `scripting.executeScript` で自動的に再注入を試みる）。

### 開発用コマンド

```bash
npm run dev
npm test
npm run typecheck
```

- `npm run dev` — `http://localhost:5173` で**拡張と同じトレーナーページ**を開く。
  HMR が効くので、キャリブレーションウィザード・HUD・設定パネル・カメラ周りの反復は
  こちらが速い（`index.html` → `extension/trainer.ts`）。ただし Shorts の操作は
  `chrome.runtime` 越しなので localhost では機能せず、接続バーに
  「localhost では Shorts を操作できません」と出る。カメラなしなら
  `http://localhost:5173/?source=keyboard`。
  骨格と信号グラフだけ見たいときは `http://localhost:5173/dev-camera.html`。
- `npm test` — vitest 113件（`core/` は `environment: 'node'`）。
- `npm run typecheck` — `tsc --noEmit`。

> **注意（zsh）**: コマンドはコメントを付けずに1行ずつ実行すること。zsh は
> 対話シェルでは既定で `#` をコメント開始文字として扱わない（bash と違う挙動）ため、
> `npm run dev  # コメント` のように行末にコメントを書いて貼り付けると、`# コメント`
> がそのままコマンドの引数として渡ってしまう。特に `npm run dev` の場合、Vite の
> CLI が最初の位置引数を「プロジェクトルート」として解釈するため、`#` をルート
> ディレクトリ名と誤認して `The project root contains the "#" character` という
> 警告が出る（実害はないが、正しく動いていない可能性があるので付けないこと）。

## ⚠️ 安全上の注意

- **軽重量・高レップ前提**の設計です。高重量トレーニングでの「ながら」使用は避けてください。
- 肘・手首・肩に痛みが出たら直ちに中止してください。
- 反動（勢い）を使わず、フォームを崩さないでください。
- 日次レップ上限（既定300レップ ≒ 視聴30分/日）と強制クールダウンは安全機構であり、
  回避を目的とした設定変更は推奨しません。

## 実装の要点

拡張のコードは `extension/` 以下。**`core/` はほぼ手を入れずに Shorts へ移行できた**
（`controller.ts` に足したのは per-slide 分岐と `maxTickDtMs` の2箇所だけで、
どちらも DOM / TFJS / `chrome.*` に依存しない）。

### 報酬方式

拡張の初回起動時は **per-slide プリセット**（`grant: 'per-slide'`, N=1, X=30秒,
貯蓄上限60秒）で始まる。つまり **1回ダンベルを挙げたら次のショートに送られて30秒見られる**。
トレーナーの設定パネルでバンキング方式（N レップ → X 秒。スライドは自分で送る）に
切り替えられる。

`localStorage` は `chrome-extension://` のオリジンに紐づくので、`npm run dev` で
`localhost:5173` に開いたときとは設定・残高が別勘定になる（同じページなのに
残高が違って見えるのはこれが理由）。

### アーキテクチャ

| ファイル | 役割 |
|---|---|
| `extension/protocol.ts` | 3者が共有するメッセージ型。`chrome.*` にも DOM にも触らない |
| `extension/background.ts` | トレーナーウィンドウの管理 + タブ解決 + メッセージ転送 |
| `extension/trainer.ts` | ★**アプリの唯一のエントリポイント**。全部の結線 |
| `extension/shorts-extension-slider.ts` | `Slider` 実装。命令を**直列化**して送る |
| `extension/content/shorts.ts` | Shorts 側の受け口。再生ゲートとロックの強制 |
| `extension/content/reel-dom.ts` | ★**壊れるのはここだけ**。DOM の知識を全部閉じ込めてある |
| `extension/content/page-lock.ts` | YouTube 自身の JS ごと止めるロック |

### 知っておくべき実装上の判断

- **合成キーイベントは使えない**。UI Events 仕様で untrusted event は
  `preventDefault()` された扱いになる（Chrome 53 から実装済み）。偽の「↓キー」は
  効かないので `scrollIntoView` / `scrollBy` で送る。
- **`page-lock.ts` は `stopImmediatePropagation()` まで呼ぶ**。自分のページなら
  `preventDefault()` で既定のスクロールを止めれば済むが、他人のページでは
  YouTube 自身の wheel/keydown ハンドラごと止めないと独自にスクロールされる。
- **再生ゲートは非対称**。`pause` は 250ms 間隔で継続的に強制（YouTube の autoplay と
  戦う側）、`play` は命令時に一度だけ。`playbackRate` は 1.0 に固定する。
- **`trainer.ts` の tick は rAF ではなく `setInterval`**。トレーナーウィンドウが
  YouTube に覆われるのは通常の使い方であり、rAF だと Chrome に止められて
  **クレジットが一切減らなくなる**（無限視聴の抜け穴）。`maxTickDtMs: 2000` と
  併せて塞いでいる。
- **`@crxjs/vite-plugin` は使っていない**。manifest は `vite.config.extension.ts` の
  30行のプラグインで足り、content script は結局 YouTube の実ページでしか検証
  できない（HMR の恩恵が薄い）。依存を増やしてバージョン追従リスクを負う理由がない。
- content script は MV3 で ES module を読み込めないため、**単一 IIFE の別ビルド**
  （`vite.config.content.ts`）にしている。これが vite config が2つある唯一の理由。

### セレクタが壊れたときの直し方

Shorts の DOM は平均2〜3か月ごとに変わる（実運用拡張のコミット履歴で確認:
2025-04, 05, 06, 12 / 2026-02, 06, 08）。壊れたら **`extension/content/reel-dom.ts`
の `REEL_SELECTORS` だけ**を直す。

`next()` は3段のフォールバックを持ち、トレーナーの接続バーに**どの戦略で通ったかが
常に表示される**:

1. `ordinal-id` — ラッパの `id` の序数で次を引く（正常時）
2. `dom-sibling` — DOM 上の次の兄弟ラッパ
3. `scroll-by-viewport` — スクロールコンテナを1画面分送る（最後の保険）

**接続バーに `scroll-by-viewport` が出続けたらセレクタが劣化した合図**。3つ全部
失敗した場合は「Shorts の構造が変わりました」がバーに出る（サイレント失敗しない）。

### 2026-09-09 に実機で確認した DOM（次に壊れたときの比較用）

```
ラッパ         .reel-video-in-sequence-new  ×10   id="0","1","2",… の連番
              （.reel-video-in-sequence は0件 = 旧DOM。ytd-reel-video-renderer は1件）
スクロール容器  #shorts-container            ← ★これが正解
              #shorts-inner-container は overflow-y:visible で scrollBy が1pxも効かない
動画           video.html5-main-video       ×2（現在＋先読み）
送りボタン      #navigation-button-down / -up
```

`#shorts-inner-container` を掴んでいると「戦略3の保険が黙って何もしない」状態に
なるため、`findScroller()` は **`scrollTop` に1px代入して実際に動くか確かめる機能
テスト**で候補を選ぶ（`overflow-y` の計算値を見る実装は実物に対して誤判定した）。

## 手動スモークチェックリスト

自動テストで検証しない部分（DOM・カメラ・実機挙動）はここで確認する。マイルストーンが
完了するごとに該当セクションを実施する。

### M1 — 報酬系（カメラ不要）
※ 当時は自前プレイヤー + `bank` 方式（N=10, X=60）での確認。現在の既定は
`per-slide`（N=1, X=30）なので、再確認する場合は設定を bank に切り替えること。

- [x] `j` を9回 → HUD に「あと1レップ」、クレジット0秒、再生されない
- [x] 10回目 → 付与音、クレジット60秒
- [x] `k`（無効レップ）→ 低い音 + HUD に理由が出る。クレジットは増えない
- [x] リロード → クレジット残高・累積レップ・設定が復元される
- [x] 設定で N/X を変更 → 即座に反映される（既存の残高は新しい policy に引き継がれる）
- [ ] HUD が2m離れた場所から読める（レップ数・残クレジット）※実機での目視確認が必要

上記（HUD 目視以外）は Playwright（headless Chromium、scratchpad に一時インストール、
プロジェクトの devDependencies には追加していない）で自動検証済み。console/page エラー
なし。ユニットテスト 19件（`npm test`）も全て通過。

### M2 — プレイヤー（削除済み）

自前の縦型プレイヤーで検証していたセクション。YouTube Shorts に一本化したため
**このセクションは下の「手動スモークチェックリスト — 拡張」に引き継がれた**。
当時確認した「クレジット枯渇で再生停止 + スクロールロック」「wheel/キーの全経路封じ」は
拡張側で再検証済み（`page-lock.ts` は `stopImmediatePropagation()` まで踏み込む、
より強いロックになっている）。

### M3 — フィルタと検出器（純ロジックのみ、カメラなし）
- [x] 合成信号（正弦/ノイズ/チャタリング/ハーフレップ/欠測/停滞/非対称往復）に対して
      レップ数・validスコア・reject理由が期待通りになる（`npm test` — 73件）
- [x] 手動スライダーで検出器を目視確認（`ManualSignalSource` を一時デバッグページから
      Playwright 操作: 0→100 で1レップ計上、100→0 の下降だけでは増えない、
      ハーフレップ(0→50→0)は計上されない、を確認。検証後デバッグページは削除済み）
- [x] fps非依存性（15/24/30fpsで同一レップ数）を確認
- [x] One-Euro Filter の群遅延を実測し、フィルタ後の値で閾値判定する設計上、
      生値ベースの直感的な時間指定とはズレが出ることを把握（テストのコメント参照）

### M4 — カメラと骨格推定（レップはまだ数えない）

**確認用ページ**: `npm run dev` の後、ブラウザで `http://localhost:5173/dev-camera.html`
を開く。カメラ許可を求められたら許可する。骨格オーバーレイ付きのカメラ映像と、
fps/推論ms/tracking状態/信号グラフの dev パネルが表示される。

- [x] self-host した MoveNet モデルのロード・カメラ取得・推論・トラッキング判定の
      パイプライン全体が技術的にエラーなく動く（Playwright + Chromium の偽カメラ
      デバイスで自動検証済み。console/page エラーなし。人物が映らない偽映像では
      正しく `tracking=lost` になることも確認 — 信頼度ゲートが機能している証拠）
- [x] 鏡像表示のCSS実装（video/canvas 双方に `scaleX(-1)`、キーポイントは生座標のまま）
      をスクリーンショットで確認
- [ ] dev パネルで fps ≥ 20、推論ms ≤ 25 ※実機（ご自身のMac）での実測が必要
- [ ] 肩/肘/手首の score ≥ 0.5（自室の照明で）※実機での確認が必要
- [ ] 鏡像が正しい（右手を挙げたら画面の右側が動く）※実際に体を映して確認
- [ ] **Mac を正面 / 横45度に置いた場合の両方で信号グラフを見比べる**
      （`dev-camera.ts` の `createPoseSource({ side: 'right' })` は現在
      `elbow-angle` 固定・仮のデフォルトキャリブレーションで動作している。
      `wrist-height` を試す場合は一時的に
      `calibration: { ...DEFAULT_CALIBRATION, signal: 'wrist-height', ... }` を
      渡して比較する）※これは開発判断であり実機でしか行えない
- [ ] 20〜30分連続稼働でファン音・本体温度・バッテリー消費を確認
- [ ] `watching` 状態でカメラ LED が消える（推論停止。`pose-source.stop()` は
      `camera.stop()` を呼ぶ設計だが、実機での体感確認が必要）

**既知の実装上の注意点**（vite.config.ts 参照）: `@tensorflow-models/pose-detection`
2.1.3 は使うモデルに関わらず全モデル種別の detector を無条件に require するため、
未インストールの `@mediapipe/pose` と `tfjs-backend-webgpu` への依存がビルド時に
解決できずエラーになる。`src/stubs/empty-module.ts` へのエイリアスで回避している
（MoveNet 以外のコードパスは実行されないため安全）。

### M5 — 実カールでの E2E

トレーナーページを開くと、カメラ許可 → キャリブレーションウィザード（下端記録 →
上端記録）→ 完了後にレップ判定 + 視聴ゲートが起動する、というのが本番フロー。
拡張として動かす場合は `npm run build:ext`、UI だけ見るなら `npm run dev`。

- [x] キャリブレーションウィザードの UI フロー（開始→下端記録→上端記録→結果表示）
      と、失敗時のエラーメッセージ・「最初からやり直す」導線を Playwright で自動検証
      （偽カメラ映像には人物が映らないため `low_confidence` で正しく失敗することを
      確認 — validateCalibration の信頼度ゲートが機能している証拠）
- [x] `SessionController.stop()` が `source.stop()` を呼ばないことを確認（設定変更の
      たびにカメラが停止・再取得される実装ミスに気づいて修正済み）
- [ ] キャリブレーションで小さすぎる ROM を登録すると弾かれる ※実機で意図的に浅い
      動きを試して確認（ロジック自体は calibration.test.ts で検証済み）
- [ ] 実際にカール → Shorts が解放/送られ、数え落ち・二重カウントがない
      （既定の per-slide なら1レップごとに1本送られる）
- [ ] わざと速すぎるレップ → `too_fast` で無効
- [ ] わざと浅いカール → 15秒後に `threshold_unreachable` 診断が出る
- [ ] **カールせず立っている・歩き回る → レップが1つも出ない（偽陽性ゼロ）**
- [ ] 腕をフレームから外す → 0.7秒後に `tracking-lost`。復帰後は端に到達するまで数え始めない

上記の未チェック項目は実機（ご自身のMac・カメラ）でのみ確認できる。`SIGNAL_KIND` /
`ARM_SIDE` / `CAMERA_VIEW`（`extension/trainer.ts` 冒頭の定数）は M4 の実機比較が済んでいない
ため `elbow-angle` / `right` / `side45` を仮決めしている。実機で `wrist-height` の方が
良ければ、この3定数を変えるだけで切り替わる。

---

### 拡張（YouTube Shorts）

- [x] `.reel-video-in-sequence-new` / `#shorts-container` / `video.html5-main-video`
      が実機の Shorts に当たる（Playwright + 拡張ロードで自動検証済み）
- [x] `next` で id が 0→1→2 と進み URL も変わる（戦略 `ordinal-id`）
- [x] `pause` 中にページ側から `video.play()` を強制しても押し戻される
- [x] `playbackRate = 2` が 1.0 に戻される
- [x] ロック中に wheel×6 と ArrowDown でスクロールできない + オーバーレイに理由が出る
- [x] **ラッパのクラス名を18個全部リネームしても `scroll-by-viewport` で送れる**
      （保険が本当に効くことの確認。trainer に劣化が表示されることも確認）
- [x] `?source=keyboard` で `j` 1回 → 1スライド送り + 再生、クレジット 0:30
- [x] **Shorts を前面にして（トレーナー非フォーカス）もクレジットが実時間で減る**
      （0:27→0:22→0:16→0:11 を実測。rAF 駆動だとここで止まる）
- [x] 枯渇 → 再生停止 + 再ロック + オーバーレイ復帰 → 次のレップで復帰
- [x] console / page エラーなし
- [ ] **実カメラでのレップ検知**（上の M4 / M5 の未チェック項目と同じもの。
      `npm run dev` で開くトレーナーページは拡張と同一コードなので、
      カメラ周りはあちらの HMR で詰めてから `build:ext` するのが速い）
- [ ] 2ウィンドウを実際に並べたときの視認性（トレーナーの HUD が見えるか）
- [ ] 20〜30分連続稼働での発熱・バッテリー
