import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { pubSubEngine } from '../redis/pubsub.js';

/**
 * Lightweight, zero-dependency RFC 6455 compliant WebSocket Server
 */
export class NativeWebSocketServer extends EventEmitter {
  constructor() {
    super();
    this.clients = new Set();

    // Hook to Redis PubSub engine so any broadcast reaches WebSockets
    pubSubEngine.on('message', ({ channel, message }) => {
      this.broadcast({
        channel,
        payload: typeof message === 'string' ? safeJsonParse(message) : message
      });
    });
  }

  handleUpgrade(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }

    const acceptKey = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '\r\n'
    ];

    socket.write(headers.join('\r\n'));

    const ws = new WebSocketConnection(socket);
    this.clients.add(ws);

    ws.on('close', () => {
      this.clients.delete(ws);
    });

    ws.on('message', (data) => {
      this.emit('client_message', { ws, data });
    });

    this.emit('connection', ws);
  }

  broadcast(data) {
    const jsonStr = typeof data === 'string' ? data : JSON.stringify(data);
    for (const ws of this.clients) {
      ws.send(jsonStr);
    }
  }

  close() {
    for (const ws of this.clients) {
      ws.close();
    }
    this.clients.clear();
  }
}

class WebSocketConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.isClosed = false;

    this.socket.on('data', (chunk) => this._onData(chunk));
    this.socket.on('close', () => {
      this.isClosed = true;
      this.emit('close');
    });
    this.socket.on('error', (err) => {
      this.isClosed = true;
      this.emit('error', err);
    });
  }

  _onData(buf) {
    if (buf.length < 2) return;
    const firstByte = buf[0];
    const secondByte = buf[1];
    const opcode = firstByte & 0x0f;

    // 0x8 = close frame
    if (opcode === 0x8) {
      this.close();
      return;
    }
    // 0x9 = ping
    if (opcode === 0x9) {
      this._sendFrame(0xa, Buffer.alloc(0)); // pong
      return;
    }

    const isMasked = (secondByte & 0x80) === 0x80;
    let payloadLen = secondByte & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
      payloadLen = buf.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLen === 127) {
      payloadLen = Number(buf.readBigUInt64BE(offset));
      offset += 8;
    }

    let mask = null;
    if (isMasked) {
      mask = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    const payload = buf.subarray(offset, offset + payloadLen);
    if (isMasked && mask) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= mask[i % 4];
      }
    }

    const str = payload.toString('utf8');
    this.emit('message', str);
  }

  send(data) {
    if (this.isClosed || this.socket.destroyed) return;
    const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
    this._sendFrame(0x1, payload); // 0x1 = text frame
  }

  _sendFrame(opcode, payload) {
    const len = payload.length;
    let header;

    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode; // FIN bit + opcode
      header[1] = len;
    } else if (len <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }

    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch (_) {}
  }

  close() {
    if (this.isClosed) return;
    this.isClosed = true;
    try {
      this._sendFrame(0x8, Buffer.alloc(0));
      this.socket.end();
    } catch (_) {}
  }
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch (_) {
    return str;
  }
}

export const wsServer = new NativeWebSocketServer();
