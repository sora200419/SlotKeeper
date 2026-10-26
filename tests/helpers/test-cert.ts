import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

// Builds a throwaway self-signed X.509 certificate in memory for the webhook signature tests, so no
// private key ever lives in the repository. Minimal DER: v3, no extensions, sha256WithRSA.

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, content: Buffer) => Buffer.concat([Buffer.from([tag]), length(content.length), content]);
const seq = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));

const SHA256_WITH_RSA = Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]);
const COMMON_NAME = Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]);
const algorithm = seq(SHA256_WITH_RSA, Buffer.from([0x05, 0x00]));
const name = (cn: string) => seq(tlv(0x31, seq(COMMON_NAME, tlv(0x0c, Buffer.from(cn, 'utf8')))));
/** UTCTime, valid for years 2000-2049 (YYMMDDHHMMSSZ). */
const utcTime = (date: Date) =>
  tlv(0x17, Buffer.from(date.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z', 'ascii'));

export interface TestCert {
  pem: string;
  privateKey: KeyObject;
}

export function makeTestCert(options: { commonName: string; notBefore: Date; notAfter: Date }): TestCert {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([0x02]))), // version v3
    tlv(0x02, Buffer.from([0x01])), // serial number
    algorithm,
    name(options.commonName), // issuer (self-signed)
    seq(utcTime(options.notBefore), utcTime(options.notAfter)),
    name(options.commonName), // subject
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = sign('sha256', tbs, privateKey);
  const der = seq(tbs, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0x00]), signature])));
  const body = der.toString('base64').match(/.{1,64}/g)!.join('\n');
  return { pem: `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`, privateKey };
}
