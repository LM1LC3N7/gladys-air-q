// -----------------------------------------------------------------------------
// The protection of the air-Q local API, ported from aioairq's `encrypt.py`
// (Apache-2.0, Corant GmbH, see THIRD_PARTY_NOTICES.md):
//
//   - AES-256-CBC; the key is the device password in UTF-8, padded with the
//     character "0" up to 32 bytes, or cut to 32 bytes;
//   - an answer is `{"content": base64(iv[16] + ciphertext)}`, PKCS#7 padded;
//   - a password that does not fit shows as a padding or UTF-8 failure.
//
// The key lives only in the closure of a cipher: it is never logged, stored
// nor put in an error message.
// -----------------------------------------------------------------------------

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const BLOCK = 16;

/** Raised when an answer cannot be opened with the password: wrong password. */
export class WrongPasswordError extends Error {
  constructor() {
    super('the answer cannot be opened with this password');
    this.name = 'WrongPasswordError';
  }
}

/** Raised when the content is not even shaped like an air-Q answer. */
export class BadContentError extends Error {
  constructor(reason) {
    super(`unexpected content: ${reason}`);
    this.name = 'BadContentError';
  }
}

/** aioairq `_pass2aes`: the password bytes, "0"-padded or cut to 32 bytes. */
export function keyOf(password) {
  const bytes = Buffer.from(String(password ?? ''), 'utf8');
  if (bytes.length >= 32) {
    return bytes.subarray(0, 32);
  }
  return Buffer.concat([bytes, Buffer.alloc(32 - bytes.length, '0')]);
}

/** aioairq `_unpad_bytes`: strict PKCS#7. */
function unpad(data) {
  if (data.length === 0) {
    throw new WrongPasswordError();
  }
  const pad = data[data.length - 1];
  if (pad < 1 || pad > BLOCK || pad > data.length) {
    throw new WrongPasswordError();
  }
  for (let i = data.length - pad; i < data.length; i += 1) {
    if (data[i] !== pad) {
      throw new WrongPasswordError();
    }
  }
  return data.subarray(0, data.length - pad);
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const utf8 = new TextDecoder('utf-8', { fatal: true });

export function createCipher(password) {
  const key = keyOf(password);
  return {
    /** base64(iv + AES-CBC(PKCS#7(text))): aioairq `encode` (used by the tests). */
    encode(text) {
      const iv = randomBytes(BLOCK);
      const cipher = createCipheriv('aes-256-cbc', key, iv);
      return Buffer.concat([iv, cipher.update(Buffer.from(text, 'utf8')), cipher.final()]).toString(
        'base64',
      );
    },
    /** aioairq `decode`: the text of an answer; WrongPasswordError if it does not open. */
    decode(content) {
      if (typeof content !== 'string') {
        throw new BadContentError('not a string');
      }
      const compact = content.replace(/\s+/g, '');
      if (!BASE64.test(compact)) {
        throw new BadContentError('not base64');
      }
      const raw = Buffer.from(compact, 'base64');
      if (raw.length < 2 * BLOCK || raw.length % BLOCK !== 0) {
        throw new BadContentError('wrong length');
      }
      const decipher = createDecipheriv('aes-256-cbc', key, raw.subarray(0, BLOCK));
      // The padding is checked by hand, as aioairq does (Node's own check
      // throws a message about the key).
      decipher.setAutoPadding(false);
      const plain = Buffer.concat([decipher.update(raw.subarray(BLOCK)), decipher.final()]);
      try {
        return utf8.decode(unpad(plain));
      } catch (err) {
        throw err instanceof WrongPasswordError ? err : new WrongPasswordError();
      }
    },
  };
}
