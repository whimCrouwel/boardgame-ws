import { createServer } from 'http'
import { GameServer } from 'boardgame-ws'

const maxRooms = parseInt(process.env.MAX_ROOMS ?? '2', 10)
const maxPlayers = parseInt(process.env.MAX_PLAYERS ?? '2', 10)
let roomCount = 0

const httpServer = createServer((req, res) => {
  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ available: maxRooms - roomCount, max: maxRooms }))
  } else {
    res.writeHead(404)
    res.end()
  }
})

const server = new GameServer({
  maxPlayersPerRoom: maxPlayers,
  maxRooms,
  reconnectGraceMs: 120_000,
  roomTtlMs: 600_000,
})

server.on('roomCreated', (code) => { roomCount++; console.log(`room created: ${code} (${roomCount}/${maxRooms})`) })
server.on('roomClosed', (code) => { roomCount--; console.log(`room closed: ${code} (${roomCount}/${maxRooms})`) })
server.on('playerJoined', (code, playerId) => console.log(`join ${code}: ${playerId}`))
server.on('playerLeft', (code, playerId) => console.log(`leave ${code}: ${playerId}`))

server.attach(httpServer)
httpServer.listen(8787, () => console.log(`boardgame-ws server listening on port 8787 (max ${maxRooms} rooms)`))
