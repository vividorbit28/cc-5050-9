// Node-side DEFLATE/INFLATE adapter for src/png.js.
import zlib from 'node:zlib';

export function deflate(data) {
  return new Uint8Array(zlib.deflateSync(Buffer.from(data.buffer, data.byteOffset, data.byteLength)));
}

export function inflate(data) {
  return new Uint8Array(zlib.inflateSync(Buffer.from(data.buffer, data.byteOffset, data.byteLength)));
}
