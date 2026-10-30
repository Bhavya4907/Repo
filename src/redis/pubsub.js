import { EventEmitter } from 'node:events';
import { RespParser } from './resp-parser.js';

export class PubSubEngine extends EventEmitter {
  constructor() {
    super();
    this.channels = new Map(); // channelName -> Set(socket)
    this.socketSubscriptions = new Map(); // socket -> Set(channelName)
  }

  subscribe(channel, socket) {
    if (!this.channels.has(channel)) {
      this.channels.set(channel, new Set());
    }
    this.channels.get(channel).add(socket);

    if (!this.socketSubscriptions.has(socket)) {
      this.socketSubscriptions.set(socket, new Set());
    }
    this.socketSubscriptions.get(socket).add(channel);

    return this.channels.get(channel).size;
  }

  unsubscribe(channel, socket) {
    if (this.channels.has(channel)) {
      this.channels.get(channel).delete(socket);
      if (this.channels.get(channel).size === 0) {
        this.channels.delete(channel);
      }
    }
    if (this.socketSubscriptions.has(socket)) {
      this.socketSubscriptions.get(socket).delete(channel);
    }
  }

  unsubscribeAll(socket) {
    if (!this.socketSubscriptions.has(socket)) return;
    const channels = this.socketSubscriptions.get(socket);
    for (const channel of channels) {
      if (this.channels.has(channel)) {
        this.channels.get(channel).delete(socket);
        if (this.channels.get(channel).size === 0) {
          this.channels.delete(channel);
        }
      }
    }
    this.socketSubscriptions.delete(socket);
  }

  publish(channel, message) {
    const msgStr = typeof message === 'object' ? JSON.stringify(message) : String(message);

    // Emit on internal event bus
    this.emit('message', { channel, message: msgStr });

    let receivers = 0;
    if (this.channels.has(channel)) {
      const subscribers = this.channels.get(channel);
      receivers = subscribers.size;

      // Redis RESP Pub/Sub format:
      // *3\r\n$7\r\nmessage\r\n$<chLen>\r\n<ch>\r\n$<msgLen>\r\n<msg>\r\n
      const respPacket = RespParser.array(['message', channel, msgStr]);

      for (const socket of subscribers) {
        try {
          if (!socket.destroyed) {
            socket.write(respPacket);
          }
        } catch (err) {
          console.warn('[PubSub] Error writing to subscriber socket:', err.message);
        }
      }
    }

    return receivers;
  }

  getSubscribedChannels(socket) {
    return Array.from(this.socketSubscriptions.get(socket) || []);
  }
}

export const pubSubEngine = new PubSubEngine();
