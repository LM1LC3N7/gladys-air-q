// -----------------------------------------------------------------------------
// The port of aioairq's `encrypt.py` (and its tests, test_aes.py).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { BadContentError, WrongPasswordError, createCipher, keyOf } from '../src/cipher.js';

const PASSWORD = 'my-$ecur€-pa33w0rD';
const DATA =
  'any string, does not matter... encrypting it and decrypting it should result in the very string we started with ;-)';

test('a round trip gives the very string (aioairq test_encrypted_decrypt)', () => {
  const cipher = createCipher(PASSWORD);
  assert.equal(cipher.decode(cipher.encode(DATA)), DATA);
});

test('another password does not open it (aioairq test_decrypt_failure)', () => {
  const content = createCipher(PASSWORD).encode(DATA);
  assert.throws(() => createCipher('wrong-password').decode(content), WrongPasswordError);
});

test('the key: the UTF-8 password padded with "0" to 32 bytes, or cut to 32', () => {
  assert.deepEqual(keyOf('airqsetup'), Buffer.from(`airqsetup${'0'.repeat(23)}`));
  assert.equal(keyOf('').toString(), '0'.repeat(32));
  const long = 'x'.repeat(40);
  assert.deepEqual(keyOf(long), Buffer.from('x'.repeat(32)));
  // Bytes, not characters: "€" is three bytes.
  assert.equal(keyOf(PASSWORD).length, 32);
  assert.deepEqual(keyOf(PASSWORD).subarray(0, 20), Buffer.from(PASSWORD, 'utf8'));
  assert.equal(keyOf(PASSWORD).subarray(20).toString(), '0'.repeat(12));
  assert.equal(keyOf('€'.repeat(11)).length, 32, 'a multi-byte password is cut at 32 bytes');
});

test('an answer built with the raw AES key and a known IV opens', () => {
  const key = Buffer.from(`airqsetup${'0'.repeat(23)}`);
  const iv = Buffer.alloc(16, 7);
  const aes = createCipheriv('aes-256-cbc', key, iv);
  const content = Buffer.concat([iv, aes.update('{"co2":[500,10]}'), aes.final()]).toString(
    'base64',
  );
  assert.equal(createCipher('airqsetup').decode(content), '{"co2":[500,10]}');
});

test('strict PKCS#7 unpadding (aioairq TestUnpadBytes)', () => {
  const key = keyOf('pw');
  const raw = (plain) => {
    const iv = Buffer.alloc(16, 1);
    const aes = createCipheriv('aes-256-cbc', key, iv);
    aes.setAutoPadding(false);
    return Buffer.concat([iv, aes.update(plain), aes.final()]).toString('base64');
  };
  const cipher = createCipher('pw');
  const block = (bytes) => Buffer.from(bytes);
  // Valid: 13 bytes + 3 x 0x03; a whole block of 0x10; 15 bytes + 0x01.
  assert.equal(
    cipher.decode(raw(Buffer.concat([Buffer.from('hello world!!'), block([3, 3, 3])]))),
    'hello world!!',
  );
  assert.equal(
    cipher.decode(raw(Buffer.concat([Buffer.from('A'.repeat(16)), Buffer.alloc(16, 16)]))),
    'A'.repeat(16),
  );
  assert.equal(
    cipher.decode(raw(Buffer.concat([Buffer.from('X'.repeat(15)), block([1])]))),
    'X'.repeat(15),
  );
  // Invalid: a zero padding byte, a byte above 16, inconsistent bytes.
  assert.throws(() => cipher.decode(raw(Buffer.alloc(16, 0))), WrongPasswordError);
  assert.throws(() => cipher.decode(raw(Buffer.alloc(32, 17))), WrongPasswordError);
  assert.throws(
    () => cipher.decode(raw(Buffer.concat([Buffer.from('hello world!!'), block([3, 3, 2])]))),
    WrongPasswordError,
  );
});

test('content that is not an air-Q answer is told apart from a wrong password', () => {
  const cipher = createCipher('pw');
  assert.throws(() => cipher.decode(42), BadContentError);
  assert.throws(() => cipher.decode('not base64 !'), BadContentError);
  assert.throws(() => cipher.decode(Buffer.alloc(16).toString('base64')), BadContentError);
  assert.throws(() => cipher.decode(Buffer.alloc(40).toString('base64')), BadContentError);
});

test('no error message ever holds the password', () => {
  const content = createCipher(PASSWORD).encode(DATA);
  for (const password of ['wrong-password', 'airqsetup', 'x'.repeat(50)]) {
    try {
      createCipher(password).decode(content);
    } catch (err) {
      assert.ok(!String(err.message).includes(password));
      assert.ok(!String(err.stack).includes(password));
    }
  }
});
