# boardgame-ws

ターン制マルチプレイヤーボードゲームのためのゲーム非依存 WebSocket サーバー SDK（TypeScript / Node.js）。

ルーム管理・順序保証メッセージ中継・状態スナップショット・再接続リカバリー・プレゼンス通知をすぐに使える形で提供します。ゲームのルールはすべてクライアント側で処理するため、サーバーはゲームロジックを一切持ちません。

---

## 特徴

- **ルーム管理** — 6 文字の参加コードで友人を招待。ホスト権限（ロック・キック）付き
- **順序保証** — 全ブロードキャストにルーム固有の連番（`seq`）を付与。メッセージの欠落・重複なし
- **スナップショット** — 任意の状態 BLOB をサーバーに保存。途中参加・再接続時に即座にキャッチアップ
- **再接続** — セッショントークンで接続が切れても 2 分間（設定可）座席を確保
- **プレゼンス** — join / leave / disconnect / reconnect / kick イベントをブロードキャスト
- **チャット** — ルーム内テキストメッセージ
- **ホスト機能** — ルームのロック・アンロック、プレイヤーのキック
- **ゲーム非依存** — ペイロードは完全に不透明。どんなゲームにも使える
- **依存関係は `ws` のみ** — Socket.IO や Colyseus 不要
- **型安全** — TypeScript 完全対応。クライアント／サーバーメッセージの型定義を同梱

---

## インストール

```bash
npm install boardgame-ws
```

Node.js 18 以上、ESM（`"type": "module"`）が必要です。

---

## クイックスタート

```ts
import { GameServer } from 'boardgame-ws'

const server = new GameServer({
  maxPlayersPerRoom: 4,
  maxRooms: 10,
})

const port = await server.listen(8080)
console.log(`サーバー起動: ws://localhost:${port}`)

server.on('roomCreated', (code) => console.log(`ルーム作成: ${code}`))
server.on('playerJoined', (code, playerId) => console.log(`参加: ${code} / ${playerId}`))
```

クライアントは `PROTOCOL.md` に定義されたワイヤープロトコルを実装するだけです。クライアント SDK は不要です。

---

## API リファレンス

### `new GameServer(options?)`

| オプション | 型 | デフォルト | 説明 |
|---|---|---|---|
| `maxPlayersPerRoom` | `number` | `8` | ルームの最大人数 |
| `maxRooms` | `number` | 無制限 | サーバー全体の同時ルーム数上限 |
| `reconnectGraceMs` | `number` | `120000` | 再接続猶予ウィンドウ（ms） |
| `roomTtlMs` | `number` | `600000` | 空ルームの生存時間（ms） |
| `heartbeatIntervalMs` | `number` | `15000` | ping 間隔（ms） |
| `rateLimitPerSec` | `number` | `20` | 接続ごとの秒間メッセージ上限 |

### `server.listen(port): Promise<number>`

指定ポートで WebSocket サーバーを起動します。実際にバインドされたポート番号を返します。ポートが使用中の場合は reject されます。

### `server.attach(httpServer)`

既存の `http.Server` に WebSocket サーバーをアタッチします。HTTP エンドポイントと WebSocket を同じポートで共存させる場合に使います。

```ts
import { createServer } from 'http'

const httpServer = createServer(myHttpHandler)
server.attach(httpServer)
httpServer.listen(8080)
```

### `server.close(): Promise<void>`

WebSocket サーバーを正常にシャットダウンします。

### イベント

`GameServer` は `EventEmitter` を継承しています。すべてのイベントは監視専用（ログ・メトリクス用途）で、ゲームロジックには影響しません。

```ts
server.on('roomCreated',        (roomCode: string) => { ... })
server.on('roomClosed',         (roomCode: string) => { ... })
server.on('playerJoined',       (roomCode: string, playerId: string) => { ... })
server.on('playerLeft',         (roomCode: string, playerId: string) => { ... })
server.on('playerDisconnected', (roomCode: string, playerId: string) => { ... })
server.on('playerReconnected',  (roomCode: string, playerId: string) => { ... })
```

---

## ワイヤープロトコル

詳細は [`PROTOCOL.md`](./PROTOCOL.md) を参照してください。以下は概要です。

### 接続フロー

```
クライアント → サーバー: { "type": "hello", "reqId": 1, "nickname": "Alice" }
サーバー → クライアント: { "type": "ack",     "reqId": 1 }
サーバー → クライアント: { "type": "welcome", "playerId": "p_abc123", "token": "a1b2c3..." }
```

`token` は localStorage などに保存してください。再接続時に `hello` へ含めることで同じ `playerId` が復元されます。

### クライアント → サーバー メッセージ

| type | フィールド | 説明 |
|---|---|---|
| `hello` | `reqId`, `nickname?`（1〜32 文字）, `token?` | 最初に送る必須メッセージ |
| `room.create` | `reqId` | ルーム作成。作成者がホストになる |
| `room.join` | `reqId`, `code`（6 文字、大文字小文字不問） | 参加コードでルームに参加 |
| `room.leave` | `reqId` | ルームを退出 |
| `move` | `reqId`, `payload`（任意 JSON） | ゲームアクションをブロードキャスト |
| `chat` | `reqId`, `text`（1〜2000 文字） | チャットメッセージ |
| `snapshot.set` | `reqId`, `seq`, `state`（任意 JSON） | 現在の状態 BLOB を保存（通常はホストが送信） |
| `sync.request` | `reqId` | スナップショット＋差分を再送してもらう |
| `room.lock` | `reqId` | ルームをロック（ホスト専用） |
| `room.unlock` | `reqId` | ルームをアンロック（ホスト専用） |
| `room.kick` | `reqId`, `playerId` | プレイヤーをキック（ホスト専用） |

サイズ制限: 通常メッセージ 64KB、`snapshot.set` は 256KB。超過した場合は接続を切断します（エラーメッセージは返りません）。

### サーバー → クライアント メッセージ

| type | フィールド | 説明 |
|---|---|---|
| `ack` | `reqId` | リクエスト成功 |
| `error` | `reqId`（null の場合あり）, `code`, `message` | リクエスト失敗 |
| `welcome` | `playerId`, `token` | セッション情報（hello の後に届く） |
| `room.created` | `code`, `members` | 作成者のみに送信 |
| `room.joined` | `code`, `you`, `members`, `locked` | 参加者に送信 |
| `move` | `seq`, `playerId`, `payload` | ブロードキャスト（送信者含む） |
| `chat` | `seq`, `playerId`, `text` | ブロードキャスト |
| `snapshot` | `seq`, `state` | 参加・再接続・`sync.request` 時に送信 |
| `presence` | `seq`, `event`, `playerId`, `nickname`, `newHost?` | プレイヤーの入退室通知 |
| `room.locked` | `seq`, `playerId` | ブロードキャスト |
| `room.unlocked` | `seq`, `playerId` | ブロードキャスト |
| `room.closed` | — | ルームが閉じられた |

`members` の各要素: `{ playerId: string, nickname: string, connected: boolean, host: boolean }`

`presence` の `event` 種別: `join` / `leave` / `disconnect` / `reconnect` / `kick`

### エラーコード

| コード | 意味 |
|---|---|
| `ROOM_NOT_FOUND` | 指定のルームが存在しない |
| `ROOM_LOCKED` | ルームがロックされているため参加できない |
| `ROOM_FULL` | ルームまたはサーバーが満員 |
| `NOT_HOST` | ホスト専用操作を非ホストが試みた |
| `INVALID_MESSAGE` | メッセージの形式または内容が不正 |
| `RATE_LIMITED` | 送信レートが上限を超えた |
| `BAD_TOKEN` | 不明なセッショントークン（サーバー再起動後など） |

---

## クライアント実装ガイド

### reqId の管理

`reqId` はセッション単位で厳密に単調増加させてください。接続を張り直すたびにリセットしてはいけません。再接続後も続きの番号を使うことで、ネットワーク障害時の安全なリトライが可能になります。

```ts
// localStorage に永続化する例
function nextReqId(): number {
  const n = parseInt(localStorage.getItem('reqId') ?? '0', 10) + 1
  localStorage.setItem('reqId', String(n))
  return n
}
```

### seq の管理とギャップ検出

```ts
let lastSeq = 0

function onBroadcast(msg: { seq: number; [key: string]: unknown }) {
  if (msg.seq !== lastSeq + 1) {
    // ギャップ検出 → 再同期リクエスト
    ws.send(JSON.stringify({ type: 'sync.request', reqId: nextReqId() }))
    return
  }
  lastSeq = msg.seq
  applyMessage(msg)
}
```

### スナップショットの送信タイミング

ホストはターン終了ごとに `snapshot.set` を送ることを推奨します。これにより再接続・途中参加のリカバリーが即座に完了します。

```ts
ws.send(JSON.stringify({
  type: 'snapshot.set',
  reqId: nextReqId(),
  seq: lastSeq,      // 最後に受信したブロードキャストの seq
  state: gameState,  // ゲーム全体の状態（任意の JSON）
}))
```

`snapshot.set` の `seq` は現在サーバーに保存されているスナップショットの `seq` より小さい値を送ってはいけません（単調増加の制約）。

### BAD_TOKEN の処理

サーバー再起動後など、保存済みトークンが無効になった場合は `BAD_TOKEN` エラーが返ります。トークンを削除して新しいセッションとして再接続してください。

```ts
if (msg.type === 'error' && msg.code === 'BAD_TOKEN') {
  localStorage.removeItem('sessionToken')
  reconnectWithoutToken()
}
```

### 推奨フロー（ボードゲームの場合）

1. ホストがルームを作成し、参加コードを共有
2. プレイヤーが揃ったらホストが `room.lock` を送信
3. ゲームアクションを `move` で送信し、全プレイヤーが `seq` 順に適用
4. ホストはターンごとに `snapshot.set` を送信
5. `seq` ギャップを検出したら `sync.request` でリカバリー

---

## アーキテクチャ

```
GameServer (EventEmitter)          トランスポート層：ws・ハートビート・レート制限
  └── Router                       メッセージ検証・ルーティング
        ├── SessionManager         セッショントークン・プレイヤー識別・再接続猶予タイマー
        └── RoomManager            参加コード生成・メンバー管理・ホスト移譲・スナップショットバッファ
```

### スナップショットとバッファの仕組み

サーバーはルームごとに「最新スナップショット」と「スナップショット以降のブロードキャスト」をバッファとして保持します。`snapshot.set` を受け取るたびにバッファがリセットされます。参加・再接続時は `snapshot` → バッファの順で配信されるため、クライアントは常に最新状態から即座に再開できます。

### ホスト移譲

ホストが退出・キックされた場合、最も長く在席しているメンバーに自動的にホスト権が移譲されます。`presence` メッセージの `newHost` フィールドで通知されます。

### ハートビートと切断検知

15 秒ごとに WebSocket ping を送信します。2 回連続で応答がない場合は接続を切断し、再接続猶予ウィンドウを開始します。猶予ウィンドウ内に同じトークンで再接続すると座席が回復します。

---

## 制限・非対応事項

- **クライアント SDK なし** — ワイヤープロトコルを実装すれば任意の言語・フレームワークのクライアントが使えます
- **サーバー側ゲームロジックなし** — チート防止・ルール検証はクライアント側の責任です
- **永続化なし** — サーバー再起動でルームとセッションはすべて失われます
- **水平スケールなし** — 単一インスタンス前提です

---

## サンプル

`examples/tic-tac-toe/` に React + Vite で実装したシンプルな三目並べが含まれています。このライブラリの使い方を実際のコードで確認できます。

```bash
# ターミナル 1: WebSocket サーバー
cd examples/tic-tac-toe
npm install
npm run server

# ターミナル 2: フロントエンド開発サーバー
npm run dev
```

`http://localhost:5173` をブラウザの 2 つのタブで開き、1 つ目でルームを作成し、2 つ目でQRコードをスキャンするか参加コードを入力して対戦できます。

---

## 開発

```bash
npm test           # vitest (68 テスト)
npm run typecheck
npm run build
```

---

## ライセンス

MIT
