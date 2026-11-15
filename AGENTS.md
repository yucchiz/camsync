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

- `index.html`: 画面構造のマークアップのみ。インラインのスクリプトとスタイルは持たず、CSP を `<meta>` で宣言する。許可は `'self'` のみで、例外は添付画像のプレビュー用の `img-src blob:` と `data:` だけ。
- `styles.css`: レスポンシブ表示とアクセシビリティのスタイル。色は `:root` の CSS 変数で定義し、`prefers-color-scheme` でライト／ダークを切り替える。個別ルールに色を直書きせず、文字は 13px 以上にする（`test/ui-shell.test.mjs` が検査する）。
- `app.mjs`: DOM 連携、画面切替、イベント登録、ダイアログ、Service Worker 登録と更新案内。`APP_VERSION` を持つ。
- `lib/*.mjs`: DOM に依存しない ES モジュール。Node のテストから直接読み込める。
- `test/*.test.mjs`: Node 組み込みテストランナーのテスト。`test/fixtures/` に旧形式・現行形式の Markdown fixture を置く。
- `sw.js`: バージョン管理されたアプリシェルのキャッシュとオフライン動作。アプリシェルは install 時に作ったキャッシュだけから cache-first で返し、稼働中のキャッシュを fetch で上書きしない（版の混在を防ぐため）。
- `manifest.json`: PWA インストール用メタデータ。
- `icons/`: SVG、PNG、maskable、Apple 用のアプリケーションアイコン。

ビルド成果物とパッケージマネージャはありません。IndexedDB のデータベース名は `CamSyncDB`、スキーマバージョンは `2` です。`records` ストアは自動インクリメントの `id` キーと `timestamp` インデックスを使います（v1 から不変）。v2 で添付用に、メタ情報の `attachments`（自動インクリメントの `id`、`recordId` インデックス、`{ recordId, name, mime, size, createdAt }`）と、本体の `attachmentBlobs`（`attachments` と同じ `id` をキーに `{ id, blob }`）を追加しました。スキーマ更新は `upgradeSchema` で足りないストアだけを作り、既存ストアを削除・再作成しないでください。

### コードマップ

- `lib/result.mjs`: 検証結果の共通ヘルパー `error`、`failure`、`success`。`lib/` の検証系関数はこれで結果オブジェクトを作る。
- `lib/time.mjs`: `calculateDrift`（±12 時間に正規化した誤差計算）、`calculateTimeOffset`（時間電卓）、`normalizeExtractRange`、`validateExtractRange`、`isValidDate`、日時整形の `pad2`、`formatRecordDateTime`（`YYYY/MM/DD HH:mm`、無効値は `null`）、`formatCompactDateTime`（ファイル名用の `YYYYMMDD_HHmm[ss]`）。
- `lib/record.mjs`: `RECORD_KEYS`（記録フィールド一覧の正本。並び順はバックアップの SHA-256 に影響するため変更しない）、`canonicalizeRecord`、`validateRecord`、`FIELD_LIMITS`。保存・編集・インポート・復元はすべて `validateRecord` を通し、誤差は基準時刻とカメラ時刻から再計算して整合を確認する。
- `lib/markdown.mjs`: `serializeRecordToMarkdown`、`parseMarkdownRecord`。インポートは `MAX_MARKDOWN_BYTES`（1 MiB）で制限する。
- `lib/storage.mjs`: `openDB`、`upgradeSchema`、`addRecord`、`getAllRecords`、`getRecord`、`updateRecord`、`deleteRecord`、`clearAllRecords`、`bulkAddRecords`、`replaceAllRecords`、添付の `addAttachment`、`listAttachments`、`listAllAttachments`（Blob を含まないメタ情報）、`getAttachment`、`deleteAttachment`、個別削除の取り消し猶予 `createDeferredRecordDeleter`。失敗は `StorageError` で通知し、容量不足は `QUOTA_EXCEEDED`、旧タブによるアップグレード待ちは `BLOCKED`、新しい DB は `VERSION_MISMATCH` で区別する。`deleteRecord` は記録の添付も同じトランザクションで削除し、`clearAllRecords`・`replaceAllRecords` は添付も全件消す。
- `lib/attachment.mjs`: 添付の許可リスト `ATTACHMENT_TYPES`（JPEG・PNG・WebP・HEIC/HEIF・PDF）、上限 `ATTACHMENT_LIMITS`（1ファイル 10 MiB、1記録 10 件、ファイル名 120 文字）、先頭バイトによる種類判定 `detectAttachmentType`、`normalizeAttachmentFileName`、`validateAttachment`、`prepareAttachment`（File を検証し、判定した MIME の Blob を返す）。保存前に必ず `prepareAttachment` を通し、`file.type` や拡張子を信用しない。
- `lib/backup.mjs`: `createBackup`、`serializeBackup`、`parseBackup`（SHA-256 検証、`MAX_BACKUP_BYTES` 10 MiB、`MAX_BACKUP_RECORDS` 10,000 件）、`createDuplicatePlan`、`createRestorePlan`、`estimateSerializedBackupBytes`、`assessBackupCapacity`。失敗は `BackupError` で通知する。
- `lib/viewport.mjs`: iOS のキーボード表示後に viewport がずれる問題の補正（`createKeyboardViewportTracker`、`resolveVisibleAppHeight`）。
- `lib/draft.mjs`: 計算画面の下書き（`createDraft`、`parseDraft`、`saveDraft`、`loadDraft`、`clearDraft`）。`localStorage` の `camsync.draft.v1` に保存する。下書きは信頼しない入力として検証し、誤差の値は保存せず復元時に再計算する。固定から 24 時間を過ぎた下書きは破棄する。
- `lib/backup-status.mjs`: 最終バックアップの日時と件数（`createBackupMeta`、`saveBackupMeta`、`loadBackupMeta`）と表示文（`describeBackupStatus`）。`localStorage` の `camsync.lastBackup.v1` に保存する。
- `lib/form-errors.mjs`: `validateRecord` のエラーを入力欄単位に振り分ける `groupFormErrors`。
- `lib/storage-info.mjs`: 永続化の状態と使用量の表示文（`describePersistence`、`formatStorageUsage`）。
- `lib/safe-storage.mjs`: `localStorage` を例外なしで扱う `readItem`、`writeItem`、`removeItem`。
- `app.mjs`: フォーム要素 ID の対応表 `FORM_FIELD_IDS`（作成・編集）、ダイアログ開閉の `openDialog`／`closeDialog`／`bindDialogKeys`、誤差計算フロー（`lockClock`、`calculateCameraDrift`、`saveCurrentRecord`）、時間電卓（`runTimeCalculator`）、履歴（`renderHistory`、編集モーダル、個別削除の取り消し `removeRecord`／`undoRemoveRecord` と `recordDeleter`）、添付（`renderAttachmentList`、`attachSelectedFiles`、`previewAttachment`／`closeAttachmentPreview`、`saveAttachmentToDevice`、`shareAttachment`、`removeAttachment`）、入出力（`exportMarkdown`、`importMarkdownFile`、`backupAllRecords`、`prepareRestore`、`restoreMerge`、`restoreReplace`）。

`lib/` の検証系関数は例外を投げず `{ ok: true, value }` または `{ ok: false, errors: [{ code, field, message }] }` を返します。新しい検証もこの形に揃えてください。時間電卓は記録の永続化から分離したままにします。

## Markdown 記録の互換性

エクスポートとインポートは、`基準時刻`、`カメラ表示時刻`、`誤差`、`記録日時`、`カメラ設置場所`、`閲覧日`、`抽出日`、`立会人`、`補足` などの日本語ラベルに厳密に依存します。`serializeRecordToMarkdown` は `- **基準時刻:** 値` と書き出し、`parseMarkdownRecord` はその構造にマッチします。記録日時は分単位のため、Markdown インポート時の重複判定も分単位で比較します。補足だけは複数行を保持し、2 行目以降を半角スペース 2 つでインデントした継続行として書き出します。旧形式の ` / ` 区切りは改行に戻さず、そのままの文字列として読み込みます。ラベルや形式を変更する場合は、両方の経路を更新し、`test/fixtures/` の旧形式（同日形式、開始時刻のみ、終了時刻のみ）も引き続き受け入れてください。

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
for f in lib/*.mjs; do node --check "$f"; done
python3 -m json.tool manifest.json >/dev/null
git diff --check
```

キャッシュ対象アセットまたは `sw.js` を変更したあとは、`sw.js` の `CACHE_NAME`（`camsync-vN`）を一度だけ上げてください。ファイルを追加・削除した場合は `APP_SHELL` も更新します（`test/sw.test.mjs` が `app.mjs` からの import の漏れを検査します）。更新試験は旧版を登録した同一オリジンから通常の更新操作で行い、IndexedDB の保持を確認するためサイトデータは消去しないでください。

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
- 添付の追加（複数・一部失敗・上限・容量不足）、プレビューと blob URL の解放、保存・共有、削除、記録の削除と取り消しで添付が残ること、全件削除・全件置換で添付が残らないこと
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
