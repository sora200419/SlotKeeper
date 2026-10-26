import 'server-only';

// CRC-32 (IEEE 802.3, the zlib/PNG variant) for webhook signature messages. Node's zlib.crc32
// only exists from 20.15 / 22.2, below the engines range this app declares, so it lives here.
const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Unsigned CRC-32 of the bytes, as the decimal PayPal puts in the signed message. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
