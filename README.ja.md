# ompweb

<p align="center">
  <img src="public/favicon.svg" width="96" height="96" alt="ompweb logo" />
</p>

<p align="center">
  <strong><a href="https://github.com/can1357/oh-my-pi">oh-my-pi (omp)</a> コーディングエージェントのための Web UI アプリ。</strong>
</p>

<p align="center">
  <a href="./README.md">English</a> | <a href="./README.zh-CN.md">简体中文</a> | <a href="./README.ja.md">日本語</a> | <a href="./README.ru.md">Русский</a>
</p>

ompweb はローカル omp ランタイム用のブラウザワークスペースを提供します: 会話ブラウジング（ブランチナビゲーションとフォーク）、omp RPC プロトコルによるリアルタイムチャット、モデル / MCP / スキル管理、Git worktree 切替、そして豊富なファイルプレビュー。

<details>
<summary>📸 スクリーンショットは時に言葉よりよく物語ると信じています</summary>

| | |
| :---: | :---: |
| メインワークスペース<br>![](screenshots/screenshot-main-workspace.png) | セッション作成コンポーザー<br>![](screenshots/new-session-composer.png) |
| 展開された処理詳細（ツール呼び出し）<br>![](screenshots/chat-expanded-details.png) | コンポーザーのタスクパネル<br>![](screenshots/composer-tasks-expanded.png) |
| スラッシュコマンドメニュー<br>![](screenshots/slash-command-popover.png) | セッション情報 / コンテキストポップオーバー<br>![](screenshots/session-info-popover.png) |
| コマンドパレット<br>![](screenshots/command-palette.png) | Git Graph モーダル<br>![](screenshots/gitgraph-commit-log.png) |
| Git Graph — コミット差分<br>![](screenshots/gitgraph-commit-diff.png) | ファイルビューヤータブ<br>![](screenshots/fileviewer-tab.png) |
| セッションリスト（展開）<br>![](screenshots/sidebar-sessions-full.png) | アーカイブセッションブラウザ<br>![](screenshots/archived-sessions.png) |
| エクスプローラー（ホバー + メンション）<br>![](screenshots/explorer-hover-mention.png) | サブエージェントパネル（タスク）<br>![](screenshots/rightpanel-taskmanager.png) |
| Git パネル（変更ファイル）<br>![](screenshots/rightpanel-git.png) | Goal & Subagents ハブ（展開）<br>![](screenshots/composer-goal-subagents.png) |
| サイドチャットパネル<br>![](screenshots/rightpanel-sidechat.png) | サイドチャット（空のステート）<br>![](screenshots/rightpanel-sidechat-empty.png) |
| ファイルパネル<br>![](screenshots/rightpanel-files.png) | チャットミニマップのホバーツールチップ<br>![](screenshots/minimap-tooltip.png) |
| サービスエラー復旧キュー<br>![](screenshots/service-error-recovery.png) | チャットイベントアクション<br>![](screenshots/chat-event-actions-section.png) |
| チャットイベントアクションのモダール<br>![](screenshots/chat-event-actions-modals.png) | スケジューラ編集ダイアログ<br>![](screenshots/scheduler-edit-modal.png) |
| 組み込みターミナル（開いた状態）<br>![](screenshots/embedded-terminal.png) | テーマパレット — 静的<br>![](screenshots/themepalette-static.png) |
| テーマパレット — フローティング<br>![](screenshots/themepalette-flowing.png) | テーマパレット — モーション<br>![](screenshots/themepalette-motion.png) |
| テーマパレット — フォント<br>![](screenshots/themepalette-font.png) | テーマパレット — UI フォントスケーリング<br>![](screenshots/theme-palette-ui-scale-settings.png) |
| 設定 — インターフェースと動作<br>![](screenshots/settings-interface-behavior.png) | 設定 — セキュリティと承認<br>![](screenshots/settings-safety-approvals.png) |
| 設定 — AI モデルデフォルト<br>![](screenshots/settings-ai-model-defaults.png) | 設定 — エージェントとインテリジェンス<br>![](screenshots/settings-agent-intelligence.png) |
| 設定 — エージェント<br>![](screenshots/settings-agents.png) | 設定 — 拡張機能とツール<br>![](screenshots/settings-extensions-tools.png) |
| 設定 — OMP ネイティブ<br>![](screenshots/settings-omp-native.png) | 設定 — リモートアクセス<br>![](screenshots/settings-remote-access.png) |
| 設定 — スキルハブ<br>![](screenshots/settings-skill-hub.png) | 設定 — システムと更新<br>![](screenshots/settings-system-updates.png) |
| 設定 — 検索<br>![](screenshots/settings-search.png) | 設定 — 診断と復旧<br>![](screenshots/settings-diagnostics.png) |
| テーマ: Light（Warm Paper）<br>![](screenshots/screenshot-theme-light.png) | テーマ: omp Midnight<br>![](screenshots/screenshot-theme-omp-midnight.png) |
| テーマ: Oatmeal Latte<br>![](screenshots/screenshot-theme-oatmeal-latte.png) | テーマ: Monokai Pro<br>![](screenshots/screenshot-theme-monokai-pro.png) |
| テーマ: Monokai Pro Spectrum<br>![](screenshots/screenshot-theme-monokai-pro-spectrum.png) | テーマ: Omarchy Monokai<br>![](screenshots/screenshot-theme-omarchy-monokai.png) |
| テーマ: Monochrome (Codex)<br>![](screenshots/screenshot-theme-monochrome-codex.png) | テーマ: Monokai Pro Light Sun<br>![](screenshots/screenshot-theme-monokai-pro-light-sun.png) |
| テーマ: Rosé Pine Dawn<br>![](screenshots/screenshot-theme-rose-pine-dawn.png) | テーマ: Harbor<br>![](screenshots/screenshot-theme-harbor.png) |
| テーマ: Catppuccin Mocha<br>![](screenshots/screenshot-theme-catppuccin-mocha.png) | モバイル: Harbor<br>![](screenshots/screenshot-theme-harbor-mobile.png) |
| テーマ: Nord Arctic<br>![](screenshots/screenshot-theme-nord.png) | テーマ: Kyoto Matcha<br>![](screenshots/screenshot-theme-matcha.png) |
| テーマ: OLED Obsidian<br>![](screenshots/screenshot-theme-oled.png) | テーマ: Warm Ember<br>![](screenshots/screenshot-theme-dark.png) |
| テーマ: Antique Vellum<br>![](screenshots/screenshot-theme-sepia.png) | テーマ: Dracula Velvet<br>![](screenshots/screenshot-theme-dracula.png) |
| テーマ: Pine Forest<br>![](screenshots/screenshot-theme-pine.png) | テーマ: Horizon Navy<br>![](screenshots/screenshot-theme-navy.png) |
| テーマ: Monokai Classic<br>![](screenshots/screenshot-theme-monokai.png) | テーマ: Monokai Pro Octagon<br>![](screenshots/screenshot-theme-monokai-pro-octagon.png) |
| テーマ: Monokai Pro Machine<br>![](screenshots/screenshot-theme-monokai-pro-machine.png) | テーマ: Monokai Pro Ristretto<br>![](screenshots/screenshot-theme-monokai-pro-ristretto.png) |
| テーマ: Monokai Pro Light<br>![](screenshots/screenshot-theme-monokai-pro-light.png) | テーマ: One Light<br>![](screenshots/screenshot-theme-one-light.png) |
| テーマ: One Dark Pro<br>![](screenshots/screenshot-theme-one-dark-pro.png) | テーマ: Catppuccin Latte<br>![](screenshots/screenshot-theme-catppuccin-latte.png) |
| テーマ: Gruvbox Dark<br>![](screenshots/screenshot-theme-gruvbox-dark.png) | テーマ: Tokyo Night<br>![](screenshots/screenshot-theme-tokyo-night.png) |
| テーマ: Rosé Pine<br>![](screenshots/screenshot-theme-rose-pine.png) | モバイル: Light（Warm Paper）<br>![](screenshots/screenshot-theme-light-mobile.png) |
| モバイル: Nord Arctic<br>![](screenshots/screenshot-theme-nord-mobile.png) | モバイル: Oatmeal Latte<br>![](screenshots/screenshot-theme-oatmeal-mobile.png) |
| モバイル: Kyoto Matcha<br>![](screenshots/screenshot-theme-matcha-mobile.png) | モバイル: OLED Obsidian<br>![](screenshots/screenshot-theme-oled-mobile.png) |
| モバイル: Monochrome (Codex)<br>![](screenshots/screenshot-theme-codex-mobile.png) | モバイル: Warm Ember<br>![](screenshots/screenshot-theme-dark-mobile.png) |
| モバイル: Antique Vellum<br>![](screenshots/screenshot-theme-sepia-mobile.png) | モバイル: Dracula Velvet<br>![](screenshots/screenshot-theme-dracula-mobile.png) |
| モバイル: Pine Forest<br>![](screenshots/screenshot-theme-pine-mobile.png) | モバイル: Horizon Navy<br>![](screenshots/screenshot-theme-navy-mobile.png) |
| モバイル: Omarchy Monokai<br>![](screenshots/screenshot-theme-omarchy-monokai-mobile.png) | モバイル: Monokai Classic<br>![](screenshots/screenshot-theme-monokai-mobile.png) |
| モバイル: Monokai Pro<br>![](screenshots/screenshot-theme-monokai-pro-mobile.png) | モバイル: Monokai Pro Octagon<br>![](screenshots/screenshot-theme-monokai-pro-octagon-mobile.png) |
| モバイル: Monokai Pro Machine<br>![](screenshots/screenshot-theme-monokai-pro-machine-mobile.png) | モバイル: Monokai Pro Ristretto<br>![](screenshots/screenshot-theme-monokai-pro-ristretto-mobile.png) |
| モバイル: Monokai Pro Spectrum<br>![](screenshots/screenshot-theme-monokai-pro-spectrum-mobile.png) | モバイル: Monokai Pro Light<br>![](screenshots/screenshot-theme-monokai-pro-light-mobile.png) |
| モバイル: Monokai Pro Light Sun<br>![](screenshots/screenshot-theme-monokai-pro-light-sun-mobile.png) | モバイル: omp Midnight<br>![](screenshots/screenshot-theme-omp-mobile.png) |
| モバイル: One Light<br>![](screenshots/screenshot-theme-one-light-mobile.png) | モバイル: One Dark Pro<br>![](screenshots/screenshot-theme-one-dark-pro-mobile.png) |
| モバイル: Catppuccin Latte<br>![](screenshots/screenshot-theme-catppuccin-latte-mobile.png) | モバイル: Catppuccin Mocha<br>![](screenshots/screenshot-theme-catppuccin-mocha-mobile.png) |
| モバイル: Gruvbox Dark<br>![](screenshots/screenshot-theme-gruvbox-dark-mobile.png) | モバイル: Tokyo Night<br>![](screenshots/screenshot-theme-tokyo-night-mobile.png) |
| モバイル: Rosé Pine<br>![](screenshots/screenshot-theme-rose-pine-mobile.png) | モバイル: Rosé Pine Dawn<br>![](screenshots/screenshot-theme-rose-pine-dawn-mobile.png) |
</details>

## 🐳 Docker で実行

本プロジェクトは主に Docker（Linux）での実行に適応されています: リポジトリ直下の `docker-compose.yaml` がイメージをビルドし、リポジトリをマウントし、ランチャーポートをマップします。1 コマンドで起動できます:

```bash
docker compose up -d --build
```

次に [http://127.0.0.1:6767](http://127.0.0.1:6767) を開きます（パスワードは下記の**環境変数**を参照）。
注: compose ファイルはデフォルトで `c:/users/dev/.omp` をコンテナ内の `/root/.omp` にバインドします — コンテナを起動する前に、この `source:` パスをご自身のユーザーの `.omp` ストア（Linux では `~/.omp`、Windows では `c:/users/{user}/.omp`）に更新してください。そうすることで、コンテナは既存の認証情報・セッション・設定を使用します。

モバイル Web 版はフル機能の PWA であり、スマホのホーム画面に追加すればネイティブアプリのように利用できます。
スタンドアロンの Windows / Linux / macOS アプリとしてビルド・実行することも同等にサポートされています。
プロジェクトのフォークと拡張は明示的に推奨されています。

## ⚙️ ポート

ランチャーは `SIBLING_PORTS = [30177, 30178, 30179]` を探査します（`bin/omp-web.js` にハードコード）。`docker-compose.yaml` はこれら 3 つのポートすべてをコンテナにマップしています。エージェントがコンテナ内で dev サーバーを起動し、ホストのブラウザからアクセス / デバッグしたい場合には、これらのポートを使用してください。

## 🔑 デフォルトパスワード

compose ファイルはデフォルトで `OMP_WEB_PASSWORD=asdf1234` を設定しています — ログイン画面でこのパスワードを使用するか、ご自身の値に上書きしてください。

## 🔄 ビルド & 再起動（リポジトリをマウントした場合）

リポジトリがコンテナにマウントされている場合（compose のデフォルト）、`ompweb-rebuild-restart.sh` スクリプトが **Script schedulers** 設定に *手動起動* のスケジューラとして登録されます — エージェントがソースを変更した後に ompweb を再ビルド・再デプロイする便利な手段です。その後、新しいビルドを反映するにはページの再読み込みだけで済みます。新しいビルドのデプロイが完了し OmpWeb が起動すると、UI 内通知が表示され、**Refresh page** ボタンが提供されます。注意: 同時に ompweb dev サーバーのインスタンスが動いていると、メインインスタンスのビルドが時々古くなることがあります。

## 🤖 Agents MCP

バンドルされたマルチエージェント **Agent MCP** サーバーはデフォルトで無効です。OMP エージェントが異なるエージェントを生成・調整する予定がある場合は、有効にしてください（Settings → Extensions & Tools → MCP）。

## 🙏 クレジットと改善

本プロジェクトは `kahme247` と `37chengshan` のフォークからの改善を取り込んでおり、有用な機能のみを厳選してコードベースにエレガントにマージしました。大部分の修正は Splinterjke によって提供されました。主な改善:

- ファイル閲覧やスクロールバーの挙動などの重大なバグは大半解消済みですが、あえて一部はあなたに任せておくことにしました（笑）
- 設定可能なコンテキスト圧縮（Context Compaction）設定と優先度
- 多数の新テーマ・パレット（Monokai 系、Omarchy Monokai、Catppuccin、Rosé Pine、Harbor、omp Midnight、Oatmeal Latte など）— サーフェストークンの修正とテーマ対応テキスト選択
- Git Graph モーダル — リポジトリ履歴の可視化、コミット単位のファイル diff 閲覧
- RPC / IPC 通信の改善 — サーバー再起動後のセッション復元とターン継続を含む
- OmpWeb 再ビルド & 再起動関連の修正 — 明示的な Refresh ボタン付きの更新通知、loopback `/api/ui/refresh` の免除、手動スケジューラのシード
- チャットミニマップ / スクロールバーの改善 — フルハイトレール、グラデーションアクセントビーム、レール高さで制約されたサム、大きなホバーツールチップ
- チャット入力欄の時計周方向グラデーションボーダービーム
- 統一された汎用フォントサイズ設定
- 左サイドバーの展開可能・リサイズ可能なセクション、リサイズ可能なサイドバー / ワークベンチパネル
- スクリプトスケジューラ機能（間隔、毎日の、毎週の、cron、手動）と専用設定パネル
- 改善された Skill Hub と Agents 設定ページ — Skill Hub と Agents はアクティブなワークスペースだけでなく、各ワークスペースのインスタンスを表示
- より良い新規セッションコンポーザー（ワークスペースピッカー、プラスメニュー添付、コンテキストリング）
- 展開可能な thinking / detail ブロック、完全なツール入力のインライン展開
- 3 区間トップバー（中央にワークスペース / セッションパンくず）、セッション情報ポップオーバー、コンポーザー内 sub-agents ハブ
- 不要物の削除、レイアウト / 余白 / 性能の整理

## 🛠️ 環境変数

| 変数 | 意味 | デフォルト / 例 |
| :--- | :--- | :--- |
| `PORT` / `-p` / `--port` | サーバーポート | `6767` |
| `OMP_WEB_HOSTNAME` / `-H` / `--hostname` | バインドするホスト名 | `127.0.0.1` |
| `OMP_WEB_PASSWORD` / `--password` | サインイン用パスワード（compose デフォルト: `asdf1234`） | *(未設定 = 無効)* |
| `OMP_WEB_ALLOWED_HOSTS` | アプリに接続を許可する非ループバックホスト（カンマ区切り） | *(空 — ループバックのみ)* |
| `OMP_WEB_NO_OPEN` | ブラウザの自動起動をスキップ | `0`（`1` でスキップ） |
| `OMP_WEB_OMP_BIN` | `omp` バイナリの絶対パス | `PATH` から解決 |
| `OMP_WEB_STT_ENDPOINT` | OpenAI 互換の音声認識エンドポイント URL | _なし（無効）_ |
| `OMP_WEB_STT_KEY` | STT エンドポイント用の API キー | _なし_ |
| `OMP_WEB_STT_MODEL` | STT エンドポイント用のモデル名 | _なし_ |
| `PI_CODING_AGENT_DIR` | OMP エージェントディレクトリ | `~/.omp/agent` |
| `HTTP_PROXY` / `HTTPS_PROXY` | サーバーサイドリクエスト用のプロキシ | *(システムデフォルト)* |

## 📄 ライセンス

[MIT ライセンス](./LICENSE) のもとで公開されています。
