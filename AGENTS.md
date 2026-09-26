# リポジトリガイドライン

## プロジェクト概要と製品意図

CamSync は、防犯カメラの表示時刻と端末時計を比較し、誤差（ドリフト）を記録するための、依存関係なし・モバイルファーストの静的 PWA です。GitHub Pages を含め、完全にクライアントサイドで動作し、記録はブラウザの IndexedDB に保存します。コア機能は、バックエンド、アカウント、クラウドデータベース、分析サービス、サードパーティランタイムを必要としてはなりません。

記録には、カメラ設置場所、閲覧日・抽出日、立会人、補足などが含まれることがあります。これらは機微な運用データとして扱ってください。独立した時刻計算機は現場用のユーティリティであり、明示的に求められない限り、保存済みのドリフト記録と接続しないでください。

## エージェント作業ルール

- ユーザーへの応答は日本語で行う。コードコメント、コミット、ドキュメントはリポジトリの既存の言語に従う。
- 編集前に既存ファイルとパターンを確認し、小さく検証可能な変更にする。
- 明示的に大きなアーキテクチャ変更が承認されない限り、依存関係なしを維持し、静的な GitHub Pages デプロイを保つ。
- 明示的な承認なしに、サーバー保存、分析、リモートログ、外部フォント、CDN スクリプト、ネットワーク呼び出しを追加しない。
- 実務上可能な限り、既存の IndexedDB データとエクスポート済み Markdown の互換性を維持する。
- 可能な場合はブラウザで変更を検証する。静的チェックのみの場合は、その制限を明記する。

## プロジェクト構成とモジュール構成

- `index.html`: 画面構造のマークアップのみ。インラインのスクリプトとスタイルは持たず、CSP（`'self'` のみ）を `<meta>` で宣言する。
- `styles.css`: レスポンシブ表示とアクセシビリティのスタイル。
- `app.mjs`: DOM 連携、画面切替、イベント登録、ダイアログ、Service Worker 登録と更新案内。`APP_VERSION` を持つ。
- `lib/*.mjs`: DOM に依存しない ES モジュール。Node のテストから直接読み込める。
- `test/*.test.mjs`: Node 組み込みテストランナーのテスト。`test/fixtures/` に旧形式・現行形式の Markdown fixture を置く。
- `sw.js`: バージョン管理されたアプリシェルのキャッシュとオフライン動作。
- `manifest.json`: PWA インストール用メタデータ。
- `icons/`: SVG、PNG、maskable、Apple 用のアプリケーションアイコン。

ビルド成果物とパッケージマネージャはありません。IndexedDB のデータベース名は `CamSyncDB`、スキーマバージョンは `1` で、`records` ストアは自動インクリメントの `id` キーと `timestamp` インデックスを使います。

### コードマップ

- `lib/time.mjs`: `calculateDrift`（±12 時間に正規化した誤差計算）、`calculateTimeOffset`（時間電卓）、`normalizeExtractRange`、`validateExtractRange`、`isValidDate`。
- `lib/record.mjs`: `canonicalizeRecord`、`validateRecord`、`FIELD_LIMITS`。保存・編集・インポート・復元はすべて `validateRecord` を通し、誤差は基準時刻とカメラ時刻から再計算して整合を確認する。
- `lib/markdown.mjs`: `serializeRecordToMarkdown`、`parseMarkdownRecord`。インポートは `MAX_MARKDOWN_BYTES`（1 MiB）で制限する。
- `lib/storage.mjs`: `openDB`、`addRecord`、`getAllRecords`、`getRecord`、`updateRecord`、`deleteRecord`、`clearAllRecords`、`bulkAddRecords`、`replaceAllRecords`。失敗は `StorageError` で通知する。
- `lib/backup.mjs`: `createBackup`、`serializeBackup`、`parseBackup`（SHA-256 検証、`MAX_BACKUP_BYTES` 10 MiB、`MAX_BACKUP_RECORDS` 10,000 件）、`createDuplicatePlan`、`createRestorePlan`、`estimateSerializedBackupBytes`、`assessBackupCapacity`。失敗は `BackupError` で通知する。
- `lib/viewport.mjs`: iOS のキーボード表示後に viewport がずれる問題の補正（`createKeyboardViewportTracker`、`resolveVisibleAppHeight`）。
- `app.mjs`: 誤差計算フロー（`lockClock`、`calculateCameraDrift`、`saveCurrentRecord`）、時間電卓（`runTimeCalculator`）、履歴（`renderHistory`、編集モーダル）、入出力（`exportMarkdown`、`importMarkdownFile`、`backupAllRecords`、`prepareRestore`、`restoreMerge`、`restoreReplace`）。

`lib/` の検証系関数は例外を投げず `{ ok: true, value }` または `{ ok: false, errors: [{ code, field, message }] }` を返します。新しい検証もこの形に揃えてください。時間電卓は記録の永続化から分離したままにします。

## Markdown 記録の互換性

エクスポートとインポートは、`基準時刻`、`カメラ表示時刻`、`誤差`、`記録日時`、`カメラ設置場所`、`閲覧日`、`抽出日`、`立会人`、`補足` などの日本語ラベルに厳密に依存します。`serializeRecordToMarkdown` は `- **基準時刻:** 値` と書き出し、`parseMarkdownRecord` はその構造にマッチします。記録日時は分単位のため、Markdown インポート時の重複判定も分単位で比較します。ラベルや形式を変更する場合は、両方の経路を更新し、`test/fixtures/` の旧形式（同日形式、開始時刻のみ、終了時刻のみ）も引き続き受け入れてください。

全件バックアップ JSON（`format: camsync-backup`、`formatVersion: 1`）も互換性の対象です。形式を変える場合は `formatVersion` を上げ、既存バックアップの読み込みを維持してください。

## ビルド、テスト、開発コマンド

IndexedDB とサービスワーカーが本番と同様に動作するよう、リポジトリを HTTP で配信します。

```sh
python3 -m http.server 8000
```

`http://localhost:8000/` を開いてください。自動テストと静的チェックは次のとおりです。

```sh
node --test test/*.test.mjs
node --check app.mjs
node --check sw.js
node --check lib/*.mjs
python3 -m json.tool manifest.json >/dev/null
git diff --check
```

キャッシュ対象アセットまたは `sw.js` を変更したあとは、`sw.js` の `CACHE_NAME`（`camsync-vN`）を一度だけ上げてください。ファイルを追加・削除した場合は `APP_SHELL` も更新します。更新試験は旧版を登録した同一オリジンから通常の更新操作で行い、IndexedDB の保持を確認するためサイトデータは消去しないでください。

バージョンを上げる場合は、`app.mjs` の `APP_VERSION`、`index.html` の初期表示（`id="appVersion"`）、`README.md` の「このソースのバージョン」を揃えます。`test/ui-shell.test.mjs` がこの一致を検査します。

## コーディングスタイルと命名規約

インデントはスペース 2 つです。JavaScript は ES モジュール（`.mjs`）で、関数と変数は `camelCase`、定数は `UPPER_SNAKE_CASE`、CSS クラスは kebab-case を使います。短く単一目的の関数と、ブラウザネイティブ API を優先してください。説明が必要な抽象化は避けます。

ユーザー制御の値は `textContent` または DOM 生成で描画します。保存データやインポートデータを `innerHTML` に挿入してはなりません。CSP がインラインのスクリプト・スタイル・イベント属性を禁止しているため、操作は `app.mjs` の `addEventListener` で登録し、スタイルは `styles.css` に置いてください。

## テストガイドライン

`lib/` のロジックは Node 組み込みのテストランナーでテストします（外部フレームワークなし、カバレッジ閾値なし）。加えて、すべての変更はモバイル幅でのブラウザスモークテストが必要です。範囲に応じて、次を検証してください。

- ドリフト計算と日境界の挙動
- 保存、編集、削除、および IndexedDB の永続化
- 旧形式と現行形式の Markdown エクスポート／インポートの往復
- オフライン読み込みとキャッシュ更新
- 全件バックアップと復元（追加・全件置換）、容量警告
- 時刻計算機の独立性

`lib/` を変更・追加する場合は、先に失敗するテストを `test/<module>.test.mjs` に追加してください。変更を出荷するために失敗しているテストを無効化してはなりません。

## アーキテクチャの方針

現状の小さく、ビルドなしのバニラ JavaScript アーキテクチャを優先します。DOM に依存しない純粋なロジックは `lib/` に置いてテスト可能にし、`app.mjs` は DOM と画面制御に専念させます。新しいファイルの追加は、テスト容易性や保守性が実質的に向上する場合に限ります。ファイルを分けるためだけにフレームワークやバンドラを導入しないでください。

## コミットとプルリクエストのガイドライン

リポジトリの Conventional Commit パターンに従い、件名は簡潔な日本語にします。例: `feat: 抽出期間の日跨ぎ指定に対応`、`fix: ...`、`docs: ...`、`chore: ...`。コミットは焦点を絞り、なぜその変更が必要かを説明してください。

プルリクエストでは、ユーザーに見える挙動、互換性への影響、実施した検証を記述します。UI 変更にはモバイルのスクリーンショットを含めてください。IndexedDB のマイグレーション、Markdown 形式の変更、サービスワーカーキャッシュの変更、残っている手動検証は明示的に記載します。

## セキュリティとデータの互換性

- Markdown インポートとバックアップ復元は信頼しない。必須フィールド、ファイルサイズ、件数、値の形式、妥当なフィールド長、未知のキー、ハッシュを、IndexedDB へ書き込む前に検証する。
- Markdown エクスポートはプレーンで予測可能に保ち、実行可能な HTML を埋め込まない。
- スキーマ変更時は、既存の IndexedDB 記録を維持するかマイグレーションする。
- サービスワーカーのスコープとキャッシュするリクエスト種別は狭く保つ。
- シークレット、トークン、認証情報、非公開 URL をハードコードしない。
- 提案された依存関係は、必要性、保守状況、ライセンス、セキュリティ、サプライチェーンリスクを確認する。

## レビューチェックリスト

セキュリティまたはデータに関わる変更を完了する前に、次を確認してください。私的データやリモート呼び出しが導入されていないこと、ユーザー制御の描画が意図どおりであること、古い記録が読み込めること、Markdown が後方互換であること、オフライン動作が維持されていること、関連するブラウザ検証を実施したこと。

## 対象外

マルチユーザー同期、サーバーサイド保存、認証、分析、テレメトリ、ビルドステップは、製品方針が明示的に変わらない限りスコープ外です。
