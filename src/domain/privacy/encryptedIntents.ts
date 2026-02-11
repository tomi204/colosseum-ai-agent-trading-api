import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

export interface EncryptedPayload {
  ciphertext: string;   // base64
  iv: string;           // base64
  tag: string;          // base64
  algorithm: typeof ALGORITHM;
}

/**
 * Derive a 256-bit encryption key from an agent's API key and the server secret.
 * Uses HKDF (SHA-256) so the same pair always produces the same deterministic key.
 */
export const deriveKey = (agentApiKey: string, serverSecret: string): Buffer => {
  const ikm = Buffer.from(`${agentApiKey}:${serverSecret}`, 'utf-8');
  return Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), Buffer.from('colosseum-intent-encryption', 'utf-8'), KEY_LENGTH));
};

/**
 * Encrypt a full trade-intent payload (JSON-serialisable object).
 */
export const encryptIntent = (
  plaintext: Record<string, unknown>,
  agentApiKey: string,
  serverSecret: string,
): EncryptedPayload => {
  const key = deriveKey(agentApiKey, serverSecret);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

  const json = JSON.stringify(plaintext);
  const encrypted = Buffer.concat([cipher.update(json, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    algorithm: ALGORITHM,
  };
};

/**
 * Decrypt an encrypted intent payload.
 */
export const decryptIntent = (
  encrypted: EncryptedPayload,
  agentApiKey: string,
  serverSecret: string,
): Record<string, unknown> => {
  const key = deriveKey(agentApiKey, serverSecret);
  const iv = Buffer.from(encrypted.iv, 'base64');
  const tag = Buffer.from(encrypted.tag, 'base64');
  const ciphertext = Buffer.from(encrypted.ciphertext, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf-8')) as Record<string, unknown>;
};
