export type Listener = (msg: Record<string, unknown>) => void

const WS_URL = 'ws://localhost:8787'
const TOKEN_KEY = 'bgws_token'
const REQ_KEY = 'bgws_reqId'

function loadToken(): string | undefined {
  return localStorage.getItem(TOKEN_KEY) ?? undefined
}

function saveToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token)
}

function nextReqId(): number {
  const n = parseInt(localStorage.getItem(REQ_KEY) ?? '0', 10) + 1
  localStorage.setItem(REQ_KEY, String(n))
  return n
}

export class Socket {
  private ws: WebSocket | null = null
  private listeners: Map<string, Set<Listener>> = new Map()
  public playerId: string | null = null
  public token: string | null = null

  connect(nickname: string): Promise<{ playerId: string; token: string }> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(WS_URL)

      this.ws.onopen = () => {
        this.send({ type: 'hello', reqId: nextReqId(), nickname, token: loadToken() })
      }

      this.ws.onmessage = (e: MessageEvent) => {
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(e.data as string) as Record<string, unknown>
        } catch {
          return
        }

        if (msg.type === 'welcome') {
          this.playerId = msg.playerId as string
          this.token = msg.sessionToken as string
          saveToken(this.token)
          resolve({ playerId: this.playerId, token: this.token })
          return
        }

        // Stale token from a previous server run — clear it and retry fresh
        if (msg.type === 'error' && msg.code === 'BAD_TOKEN') {
          localStorage.removeItem(TOKEN_KEY)
          this.ws?.close()
          this.connect(nickname).then(resolve).catch(reject)
          return
        }

        const set = this.listeners.get(msg.type as string)
        if (set) set.forEach((fn) => fn(msg))
        const all = this.listeners.get('*')
        if (all) all.forEach((fn) => fn(msg))
      }

      this.ws.onerror = () => reject(new Error('WebSocket error'))
      this.ws.onclose = () => {
        const set = this.listeners.get('close')
        if (set) set.forEach((fn) => fn({}))
      }
    })
  }

  send(payload: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload))
    }
  }

  sendWithReqId(partial: Omit<Record<string, unknown>, 'reqId'>): number {
    const reqId = nextReqId()
    this.send({ ...partial, reqId })
    return reqId
  }

  on(type: string, fn: Listener): () => void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(fn)
    return () => this.listeners.get(type)?.delete(fn)
  }

  close() {
    this.ws?.close()
  }
}

export const socket = new Socket()
