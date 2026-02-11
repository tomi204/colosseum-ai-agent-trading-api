import { describe, it, expect } from 'vitest';
import { encryptIntent, decryptIntent, deriveKey } from '../src/domain/privacy/encryptedIntents.js';

describe('Encrypted Intents', () => {
  const agentApiKey = 'test-agent-key-abc123';
  const serverSecret = 'super-secret-server-key';

  const sampleIntent = {
    agentId: 'agent-1',
    symbol: 'SOL',
    side: 'buy',
    notionalUsd: 500,
    meta: { source: 'strategy-v1' },
  };

  it('derives a consistent 32-byte key', () => {
    const key1 = deriveKey(agentApiKey, serverSecret);
    const key2 = deriveKey(agentApiKey, serverSecret);
    expect(key1).toEqual(key2);
    expect(Buffer.from(key1).length).toBe(32);
  });

  it('derives different keys for different inputs', () => {
    const key1 = deriveKey(agentApiKey, serverSecret);
    const key2 = deriveKey('different-key', serverSecret);
    const key3 = deriveKey(agentApiKey, 'different-secret');
    expect(key1).not.toEqual(key2);
    expect(key1).not.toEqual(key3);
  });

  it('encrypts and decrypts a trade intent', () => {
    const encrypted = encryptIntent(sampleIntent, agentApiKey, serverSecret);

    expect(encrypted.algorithm).toBe('aes-256-gcm');
    expect(encrypted.ciphertext).toBeDefined();
    expect(encrypted.iv).toBeDefined();
    expect(encrypted.tag).toBeDefined();

    const decrypted = decryptIntent(encrypted, agentApiKey, serverSecret);
    expect(decrypted).toEqual(sampleIntent);
  });

  it('produces different ciphertexts for the same plaintext (random IV)', () => {
    const enc1 = encryptIntent(sampleIntent, agentApiKey, serverSecret);
    const enc2 = encryptIntent(sampleIntent, agentApiKey, serverSecret);
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
    expect(enc1.iv).not.toBe(enc2.iv);
  });

  it('fails to decrypt with wrong API key', () => {
    const encrypted = encryptIntent(sampleIntent, agentApiKey, serverSecret);
    expect(() => decryptIntent(encrypted, 'wrong-key', serverSecret)).toThrow();
  });

  it('fails to decrypt with wrong server secret', () => {
    const encrypted = encryptIntent(sampleIntent, agentApiKey, serverSecret);
    expect(() => decryptIntent(encrypted, agentApiKey, 'wrong-secret')).toThrow();
  });

  it('fails to decrypt if ciphertext is tampered', () => {
    const encrypted = encryptIntent(sampleIntent, agentApiKey, serverSecret);
    // Flip a character in ciphertext
    const tampered = {
      ...encrypted,
      ciphertext: encrypted.ciphertext.slice(0, -2) + 'XX',
    };
    expect(() => decryptIntent(tampered, agentApiKey, serverSecret)).toThrow();
  });
});
