/**
 * Redis RESP (REdis Serialization Protocol) Parser & Formatter
 */

export class RespParser {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  append(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
  }

  /**
   * Parse any complete commands currently buffered.
   * Returns array of commands (each command is an array of strings).
   */
  parse() {
    const commands = [];
    while (this.buffer.length > 0) {
      const parsed = this._parseNext(0);
      if (!parsed) {
        // Incomplete command, wait for more data
        break;
      }
      commands.push(parsed.value);
      this.buffer = this.buffer.subarray(parsed.offset);
    }
    return commands;
  }

  _parseNext(offset) {
    if (offset >= this.buffer.length) return null;

    const prefix = String.fromCharCode(this.buffer[offset]);

    // Handle Inline Commands (e.g. standard telnet commands like "PING\r\n")
    if (prefix !== '*' && prefix !== '$' && prefix !== '+' && prefix !== '-' && prefix !== ':') {
      const newlineIdx = this._findCRLF(offset);
      if (newlineIdx === -1) return null;
      const line = this.buffer.subarray(offset, newlineIdx).toString('utf8').trim();
      const tokens = line.split(/\s+/).filter(Boolean);
      return { value: tokens, offset: newlineIdx + 2 };
    }

    if (prefix === '*') {
      // Array of bulk strings
      const crlf = this._findCRLF(offset);
      if (crlf === -1) return null;

      const countStr = this.buffer.subarray(offset + 1, crlf).toString('utf8');
      const count = parseInt(countStr, 10);
      if (isNaN(count)) return null;

      let currentOffset = crlf + 2;
      const elements = [];

      for (let i = 0; i < count; i++) {
        if (currentOffset >= this.buffer.length) return null;
        const elemPrefix = String.fromCharCode(this.buffer[currentOffset]);

        if (elemPrefix === '$') {
          const bulkCrlf = this._findCRLF(currentOffset);
          if (bulkCrlf === -1) return null;

          const lenStr = this.buffer.subarray(currentOffset + 1, bulkCrlf).toString('utf8');
          const len = parseInt(lenStr, 10);
          if (len === -1) {
            elements.push(null);
            currentOffset = bulkCrlf + 2;
            continue;
          }

          const strStart = bulkCrlf + 2;
          const strEnd = strStart + len;
          if (this.buffer.length < strEnd + 2) return null; // Incomplete bulk string

          const strVal = this.buffer.subarray(strStart, strEnd).toString('utf8');
          elements.push(strVal);
          currentOffset = strEnd + 2; // skip \r\n
        } else {
          // Fallback simple token
          const tokenCrlf = this._findCRLF(currentOffset);
          if (tokenCrlf === -1) return null;
          elements.push(this.buffer.subarray(currentOffset + 1, tokenCrlf).toString('utf8'));
          currentOffset = tokenCrlf + 2;
        }
      }

      return { value: elements, offset: currentOffset };
    }

    // Single bulk string
    if (prefix === '$') {
      const crlf = this._findCRLF(offset);
      if (crlf === -1) return null;
      const len = parseInt(this.buffer.subarray(offset + 1, crlf).toString('utf8'), 10);
      if (len === -1) return { value: null, offset: crlf + 2 };
      const start = crlf + 2;
      const end = start + len;
      if (this.buffer.length < end + 2) return null;
      const strVal = this.buffer.subarray(start, end).toString('utf8');
      return { value: strVal, offset: end + 2 };
    }

    return null;
  }

  _findCRLF(offset) {
    for (let i = offset; i < this.buffer.length - 1; i++) {
      if (this.buffer[i] === 0x0d && this.buffer[i + 1] === 0x0a) {
        return i;
      }
    }
    return -1;
  }

  // Formatters
  static simpleString(str) {
    return Buffer.from(`+${str}\r\n`);
  }

  static error(msg) {
    return Buffer.from(`-ERR ${msg}\r\n`);
  }

  static integer(num) {
    return Buffer.from(`:${Math.floor(num)}\r\n`);
  }

  static bulkString(str) {
    if (str === null || str === undefined) {
      return Buffer.from('$-1\r\n');
    }
    const buf = Buffer.from(String(str), 'utf8');
    return Buffer.concat([
      Buffer.from(`$${buf.length}\r\n`),
      buf,
      Buffer.from('\r\n')
    ]);
  }

  static array(items) {
    if (items === null || items === undefined) {
      return Buffer.from('*-1\r\n');
    }
    const chunks = [Buffer.from(`*${items.length}\r\n`)];
    for (const item of items) {
      chunks.push(RespParser.bulkString(item));
    }
    return Buffer.concat(chunks);
  }
}
