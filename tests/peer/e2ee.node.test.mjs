import test from "node:test";
import assert from "node:assert/strict";

import { createIdentity } from "../../nos/peer/identity.js";
import { createCodec, decryptBytes, encryptBytes, deriveSharedKey } from "../../nos/peer/e2ee.js";

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

test("both peers derive the same key and exchange ciphertext", async () => {
  const alice = await createIdentity();
  const bob = await createIdentity();
  const aliceCodec = await createCodec({
    localIdentity: alice,
    remotePublicKey: bob.publicKey,
  });
  const bobCodec = await createCodec({
    localIdentity: bob,
    remotePublicKey: alice.publicKey,
  });

  const payload = enc("secret-message");
  const encrypted = await aliceCodec.encode(payload);
  assert.notDeepEqual([...encrypted], [...payload]);
  assert.equal(dec(await bobCodec.decode(encrypted)), "secret-message");

  const tampered = encrypted.slice();
  tampered[tampered.length - 1] ^= 0xff;
  await assert.rejects(bobCodec.decode(tampered));
});

test("raw AES helpers roundtrip", async () => {
  const alice = await createIdentity();
  const bob = await createIdentity();
  const key = await deriveSharedKey(alice, bob.publicKey);
  const ciphertext = await encryptBytes(key, enc("hello"));
  assert.equal(dec(await decryptBytes(key, ciphertext)), "hello");
});
