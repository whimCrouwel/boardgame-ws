import { useState, useEffect, useCallback, useRef } from 'react'
import QRCode from 'qrcode'
import { socket } from './lib/socket'

type Screen = 'lobby' | 'waiting' | 'game'
type Board = (string | null)[]

interface GameState {
  board: Board
  xIsNext: boolean
  winner: string | null
}

function calcWinner(board: Board): string | null {
  const lines = [
    [0,1,2],[3,4,5],[6,7,8],
    [0,3,6],[1,4,7],[2,5,8],
    [0,4,8],[2,4,6],
  ]
  for (const [a,b,c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a]!
  }
  return null
}

function useQrCode(text: string) {
  const [dataUrl, setDataUrl] = useState('')
  useEffect(() => {
    if (!text) return
    QRCode.toDataURL(text, { width: 200, margin: 1 }).then(setDataUrl)
  }, [text])
  return dataUrl
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('lobby')
  const [nickname, setNickname] = useState('')
  const [joinCode, setJoinCode] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('code') ?? ''
  })
  const [roomCode, setRoomCode] = useState('')
  const [error, setError] = useState('')
  const [isHost, setIsHost] = useState(false)
  const [myMark, setMyMark] = useState<'X' | 'O'>('X')
  const [notification, setNotification] = useState('')
  const [roomStatus, setRoomStatus] = useState<{ available: number; max: number } | null>(null)
  const [game, setGame] = useState<GameState>({ board: Array(9).fill(null), xIsNext: true, winner: null })
  const seqRef = useRef(0)
  const isHostRef = useRef(false)
  const notifTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const joinUrl = roomCode
    ? `${window.location.origin}${window.location.pathname}?code=${roomCode}`
    : ''
  const qrDataUrl = useQrCode(joinUrl)

  const showNotification = useCallback((msg: string) => {
    setNotification(msg)
    if (notifTimer.current) clearTimeout(notifTimer.current)
    notifTimer.current = setTimeout(() => setNotification(''), 4000)
  }, [])

  useEffect(() => {
    fetch('/status')
      .then((r) => r.json())
      .then((data) => setRoomStatus(data as { available: number; max: number }))
      .catch(() => {})
  }, [])

  const applySnapshot = useCallback((blob: unknown) => {
    setGame(blob as GameState)
  }, [])

  useEffect(() => {
    const unsubs: (() => void)[] = []

    unsubs.push(socket.on('room.created', (msg) => {
      setRoomCode(msg.code as string)
      setIsHost(true)
      isHostRef.current = true
      setMyMark('X')
      setScreen('waiting')
    }))

    unsubs.push(socket.on('room.joined', (msg) => {
      setRoomCode(msg.code as string)
      type Member = { playerId: string; host: boolean }
      const members = (msg.members as Member[]) ?? []
      const me = members.find((m) => m.playerId === socket.playerId)
      const host = me?.host ?? false
      setIsHost(host)
      isHostRef.current = host
      setMyMark(host ? 'X' : 'O')
      setScreen('game')
    }))

    unsubs.push(socket.on('presence', (msg) => {
      const nickname = msg.nickname as string
      const event = msg.event as string
      if (event === 'join' || event === 'reconnect') {
        if (screen === 'waiting') setScreen('game')
        if (event === 'reconnect') showNotification(`${nickname} reconnected`)
      }
      if (event === 'disconnect') showNotification(`${nickname} disconnected`)
      if (event === 'leave') showNotification(`${nickname} left the game`)
      if (event === 'kick') showNotification(`${nickname} was kicked`)
    }))

    unsubs.push(socket.on('move', (msg) => {
      const seq = msg.seq as number
      seqRef.current = seq
      const payload = msg.payload as { cell?: number; reset?: boolean }

      if (payload.reset) {
        const fresh: GameState = { board: Array(9).fill(null), xIsNext: true, winner: null }
        setGame(fresh)
        if (isHostRef.current) {
          socket.sendWithReqId({ type: 'snapshot.set', seq, state: fresh })
        }
        return
      }

      setGame((prev) => {
        if (prev.winner) return prev
        const board = [...prev.board]
        board[payload.cell!] = prev.xIsNext ? 'X' : 'O'
        const winner = calcWinner(board)
        const next = { board, xIsNext: !prev.xIsNext, winner }
        if (isHostRef.current) {
          socket.sendWithReqId({ type: 'snapshot.set', seq, state: next })
        }
        return next
      })
    }))

    unsubs.push(socket.on('snapshot', (msg) => {
      applySnapshot((msg as Record<string, unknown>).state)
    }))

    unsubs.push(socket.on('error', (msg) => {
      setError(String(msg.message ?? msg.code))
    }))

    return () => unsubs.forEach((u) => u())
  }, [screen, applySnapshot, showNotification])

  async function handleConnect(creating: boolean) {
    if (!nickname.trim()) { setError('Enter a nickname'); return }
    if (!creating && !joinCode.trim()) { setError('Enter a join code'); return }
    setError('')

    try {
      await socket.connect(nickname.trim())
    } catch {
      setError('Cannot connect to server')
      return
    }

    if (creating) {
      socket.sendWithReqId({ type: 'room.create' })
    } else {
      socket.sendWithReqId({ type: 'room.join', code: joinCode.trim().toUpperCase() })
    }
  }

  function handleCellClick(i: number) {
    if (game.winner || game.board[i]) return
    const myTurn = (game.xIsNext && myMark === 'X') || (!game.xIsNext && myMark === 'O')
    if (!myTurn) return
    socket.sendWithReqId({ type: 'move', payload: { cell: i } })
  }

  function handleReset() {
    socket.sendWithReqId({ type: 'move', payload: { reset: true } })
  }

  if (screen === 'lobby') {
    return (
      <div style={styles.center}>
        <div style={styles.card}>
          <h1 style={styles.title}>Tic-Tac-Toe</h1>
          <input
            style={styles.input}
            placeholder="Your nickname"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
          />
          <input
            style={styles.input}
            placeholder="Join code (leave blank to create)"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value)}
          />
          {roomStatus && (
            <p style={{ textAlign: 'center', fontSize: 13, color: roomStatus.available === 0 ? '#c00' : '#888', marginBottom: 8 }}>
              {roomStatus.available === 0
                ? 'Server is full — no rooms available'
                : `${roomStatus.available} of ${roomStatus.max} rooms available`}
            </p>
          )}
          {error && <p style={styles.error}>{error}</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={styles.btn} onClick={() => handleConnect(true)}>Create Room</button>
            <button style={styles.btnSecondary} onClick={() => handleConnect(false)}>Join Room</button>
          </div>
        </div>
      </div>
    )
  }

  if (screen === 'waiting') {
    return (
      <div style={styles.center}>
        <div style={styles.card}>
          <h2 style={styles.title}>Waiting for opponent…</h2>
          <p style={{ textAlign: 'center', marginBottom: 12, color: '#555' }}>Scan to join:</p>
          {qrDataUrl && (
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
              <img src={qrDataUrl} alt="Join QR code" width={200} height={200} />
            </div>
          )}
          <div style={styles.code}>{roomCode}</div>
          <p style={{ textAlign: 'center', color: '#888', fontSize: 14 }}>You are X</p>
        </div>
      </div>
    )
  }

  const myTurn = (game.xIsNext && myMark === 'X') || (!game.xIsNext && myMark === 'O')
  const status = game.winner
    ? `${game.winner} wins!`
    : game.board.every(Boolean)
    ? 'Draw!'
    : myTurn
    ? 'Your turn'
    : "Opponent's turn"

  return (
    <div style={styles.center}>
      <div style={styles.card}>
        {notification && <div style={styles.notification}>{notification}</div>}
        <h2 style={styles.title}>Room: {roomCode}</h2>
        <p style={{ textAlign: 'center', marginBottom: 12 }}>
          You are <strong>{myMark}</strong> — {status}
        </p>
        <div style={styles.grid}>
          {game.board.map((val, i) => (
            <button
              key={i}
              style={{ ...styles.cell, cursor: val || game.winner ? 'default' : 'pointer' }}
              onClick={() => handleCellClick(i)}
            >
              {val}
            </button>
          ))}
        </div>
        {(game.winner || game.board.every(Boolean)) && isHost && (
          <button style={{ ...styles.btn, marginTop: 16, width: '100%' }} onClick={handleReset}>
            Play Again
          </button>
        )}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  center: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#f9f9f9',
  },
  card: {
    background: '#fff',
    borderRadius: 12,
    padding: 32,
    boxShadow: '0 2px 16px rgba(0,0,0,0.10)',
    width: 360,
  },
  title: {
    textAlign: 'center',
    marginBottom: 20,
    fontSize: 24,
    fontWeight: 700,
  },
  input: {
    display: 'block',
    width: '100%',
    marginBottom: 12,
    padding: '10px 12px',
    fontSize: 15,
    border: '1px solid #ddd',
    borderRadius: 8,
    boxSizing: 'border-box',
  },
  error: {
    color: '#c00',
    fontSize: 13,
    marginBottom: 8,
    textAlign: 'center',
  },
  notification: {
    background: '#fff3cd',
    color: '#856404',
    borderRadius: 8,
    padding: '8px 12px',
    marginBottom: 12,
    fontSize: 14,
    textAlign: 'center',
  },
  btn: {
    flex: 1,
    padding: '10px 0',
    background: '#111',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
    fontSize: 15,
    fontWeight: 600,
  },
  btnSecondary: {
    flex: 1,
    padding: '10px 0',
    background: '#fff',
    color: '#111',
    border: '1px solid #ddd',
    borderRadius: 8,
    cursor: 'pointer',
    fontSize: 15,
    fontWeight: 600,
  },
  code: {
    fontSize: 36,
    fontWeight: 800,
    letterSpacing: 8,
    textAlign: 'center',
    fontFamily: 'monospace',
    marginBottom: 8,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 8,
    marginBottom: 4,
  },
  cell: {
    height: 88,
    fontSize: 36,
    fontWeight: 700,
    background: '#f3f3f3',
    border: '1px solid #ddd',
    borderRadius: 8,
  },
}
