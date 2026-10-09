/** Raw WS handshake probe against SnowLuma OneBot port, capture HTTP rejection. */
import WebSocket from 'ws'

const url = 'ws://127.0.0.1:3001/'
console.log('connecting', url)
const ws = new WebSocket(url, {
  headers: { 'User-Agent': 'qq-bridge/0.1.5' },
})
const timer = setTimeout(() => { console.log('timeout'); ws.terminate(); process.exit(2) }, 8000)
ws.on('unexpected-response', (req, res) => {
  console.log('unexpected HTTP response:', res.statusCode, JSON.stringify(res.headers))
  let body = ''
  res.on('data', (c) => (body += c))
  res.on('end', () => { console.log('body:', body.slice(0, 500)); clearTimeout(timer); process.exit(0) })
})
ws.on('open', () => { console.log('OPEN — sending OneBot hello'); ws.send(JSON.stringify({ action: 'get_status' })); })
ws.on('message', (m) => { console.log('message:', String(m).slice(0, 300)); clearTimeout(timer); ws.close() })
ws.on('close', (code, reason) => { console.log('close:', code, String(reason)); clearTimeout(timer); process.exit(0) })
ws.on('error', (e) => { console.log('error:', e.message, e.code || ''); clearTimeout(timer); process.exit(0) })
