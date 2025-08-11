const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/*
 * Simple WebSocket server and lobby manager.
 *
 * This server is intentionally lightweight and avoids any external
 * dependencies. It serves static files from the `public` directory
 * and implements enough of the WebSocket protocol to support a
 * small real‑time multiplayer game. Players connect to the root
 * page which establishes a WebSocket connection. All clients are
 * maintained in an in‑memory list and broadcast their state to
 * each other. The server also performs rudimentary hit detection
 * when players shoot. Keep in mind that this is a demonstration
 * suitable for a small MVP and does not include authentication,
 * security, or scalability features you would expect in a
 * production system.
 */

const clients = new Map(); // id -> { socket, name, state, kills, deaths }
let nextId = 1;

// Precompute index.html and asset serving to avoid reading from disk on each request.
function serveFile(filePath, res) {
  const ext = path.extname(filePath).toLowerCase();
  let contentType = 'text/plain';
  if (ext === '.html') contentType = 'text/html';
  else if (ext === '.js') contentType = 'text/javascript';
  else if (ext === '.css') contentType = 'text/css';
  else if (ext === '.png') contentType = 'image/png';
  else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    }
  });
}

// Create HTTP server
const server = http.createServer((req, res) => {
  // Basic static file serving
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  // Prevent directory traversal attacks
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  serveFile(filePath, res);
});

// Handle WebSocket handshake and communication
server.on('upgrade', (req, socket) => {
  const acceptHeader = req.headers['sec-websocket-key'];
  if (!acceptHeader) {
    socket.end('HTTP/1.1 400 Bad Request');
    return;
  }
  // Compute accept key
  const acceptKey = crypto
    .createHash('sha1')
    .update(acceptHeader + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', 'binary')
    .digest('base64');
  const responseHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
  ];
  socket.write(responseHeaders.join('\r\n') + '\r\n\r\n');

  // Assign unique id
  const playerId = nextId++;
  const client = { socket, name: '', state: {}, kills: 0, deaths: 0, buffer: Buffer.alloc(0) };
  clients.set(playerId, client);

  // Send initial id to client
  sendWS(socket, { type: 'welcome', id: playerId });

  socket.on('data', (chunk) => {
    // Append to existing buffer
    client.buffer = Buffer.concat([client.buffer, chunk]);
    parseBuffer(client, playerId);
  });

  socket.on('end', () => {
    removeClient(playerId);
  });

  socket.on('error', () => {
    removeClient(playerId);
  });
});

function parseBuffer(client, playerId) {
  let buf = client.buffer;
  while (true) {
    if (buf.length < 2) break;
    const byte1 = buf[0];
    const byte2 = buf[1];
    const fin = (byte1 & 0x80) !== 0;
    const opcode = byte1 & 0x0f;
    const masked = (byte2 & 0x80) !== 0;
    let length = byte2 & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buf.length < 4) break;
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buf.length < 10) break;
      const high = buf.readUInt32BE(2);
      const low = buf.readUInt32BE(6);
      // We don't expect payloads > 2^32 in this game.
      length = high * 2 ** 32 + low;
      offset = 10;
    }
    let mask;
    if (masked) {
      if (buf.length < offset + 4) break;
      mask = buf.slice(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + length) break;
    let payload = buf.slice(offset, offset + length);
    if (masked) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= mask[i % 4];
      }
    }
    const message = payload.toString();
    handleMessage(client, playerId, opcode, message);
    buf = buf.slice(offset + length);
  }
  client.buffer = buf;
}

function handleMessage(client, playerId, opcode, message) {
  // Only handle text frames (opcode 1)
  if (opcode !== 0x1) return;
  try {
    const data = JSON.parse(message);
    switch (data.type) {
      case 'init': {
        client.name = data.name;
        client.state = data.state;
        broadcast({ type: 'playerJoined', id: playerId, name: data.name, state: client.state });
        // Send existing players to new client
        for (const [id, other] of clients) {
          if (id === playerId || !other.name) continue;
          sendWS(client.socket, {
            type: 'playerJoined',
            id,
            name: other.name,
            state: other.state,
            kills: other.kills,
            deaths: other.deaths,
          });
        }
        break;
      }
      case 'update': {
        // Update player's state and broadcast
        client.state = data.state;
        broadcastExcept(playerId, { type: 'update', id: playerId, state: client.state });
        break;
      }
      case 'shoot': {
        // Perform simple hit detection on server
        const shooter = client;
        const origin = data.origin;
        const direction = data.direction;
        const maxDist = 50;
        let hitId = null;
        for (const [id, other] of clients) {
          if (id === playerId) continue;
          if (!other.state) continue;
          // Bounding sphere radius: 0.6
          const dx = other.state.x - origin.x;
          const dy = other.state.y - origin.y;
          const dz = other.state.z - origin.z;
          const proj = dx * direction.x + dy * direction.y + dz * direction.z;
          if (proj < 0 || proj > maxDist) continue;
          // Closest point on ray
          const closestX = origin.x + proj * direction.x;
          const closestY = origin.y + proj * direction.y;
          const closestZ = origin.z + proj * direction.z;
          const distSq =
            (other.state.x - closestX) ** 2 + (other.state.y - closestY) ** 2 + (other.state.z - closestZ) ** 2;
          if (distSq < 0.6 * 0.6) {
            hitId = id;
            break;
          }
        }
        if (hitId) {
          const victim = clients.get(hitId);
          victim.state.health -= 25;
          if (victim.state.health <= 0) {
            shooter.kills++;
            victim.deaths++;
            victim.state.health = 100;
            // Respawn victim at random position
            victim.state.x = (Math.random() - 0.5) * 20;
            victim.state.z = (Math.random() - 0.5) * 20;
            victim.state.y = 1.6;
            broadcast({ type: 'playerKilled', killer: playerId, victim: hitId });
            // Also send update of respawned state
            broadcast({ type: 'update', id: hitId, state: victim.state });
          }
        }
        break;
      }
      default:
        break;
    }
  } catch (e) {
    // Ignore malformed packets
  }
}

function broadcast(data) {
  const message = JSON.stringify(data);
  for (const [id, client] of clients) {
    sendWS(client.socket, message, true);
  }
}

function broadcastExcept(exceptId, data) {
  const message = JSON.stringify(data);
  for (const [id, client] of clients) {
    if (id === exceptId) continue;
    sendWS(client.socket, message, true);
  }
}

function removeClient(id) {
  const client = clients.get(id);
  if (!client) return;
  clients.delete(id);
  broadcast({ type: 'playerLeft', id });
  try {
    client.socket.destroy();
  } catch (e) {}
}

function sendWS(socket, data, stringified = false) {
  // Accept either object (to be JSON stringified) or pre‑stringified
  const message = stringified ? data : JSON.stringify(data);
  const payloadLength = Buffer.byteLength(message);
  let header;
  if (payloadLength < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN bit set, text frame
    header[1] = payloadLength;
  } else if (payloadLength < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payloadLength, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payloadLength), 2);
  }
  const dataBuf = Buffer.from(message);
  socket.write(Buffer.concat([header, dataBuf]));
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log('Server listening on port', PORT);
});