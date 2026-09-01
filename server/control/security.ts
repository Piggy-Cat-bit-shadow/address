import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

export const opaqueToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export const tokenHash = (value: string): string => digest(value).toString('base64url');

export const hashPassword = async (password: string, minimumLength = 10): Promise<{ hash: string; salt: string }> => {
  if (password.length < minimumLength || password.length > 512) throw new Error('PASSWORD_LENGTH');
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64) as Buffer;
  return { hash: derived.toString('base64url'), salt: salt.toString('base64url') };
};

export const verifyPassword = async (password: string, hash: string, salt: string): Promise<boolean> => {
  const expected = Buffer.from(hash, 'base64url');
  const derived = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length) as Buffer;
  return expected.length === derived.length && timingSafeEqual(expected, derived);
};

export const masterKeyFrom = (value: string | undefined): Buffer => {
  const source = String(value || '').trim();
  const key = /^[a-f0-9]{64}$/iu.test(source) ? Buffer.from(source, 'hex') : Buffer.from(source, 'base64');
  if (key.length !== 32) throw new Error('CONFIG_MASTER_KEY must decode to exactly 32 bytes');
  return key;
};

export const encryptSecret = (value: string, key: Buffer): { ciphertext: string; iv: string; tag: string } => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
};

export const decryptSecret = (encrypted: { ciphertext: string; iv: string; tag: string }, key: Buffer): string => {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, 'base64')), decipher.final()]).toString('utf8');
};

export const safeEqual = (left: string, right: string): boolean => timingSafeEqual(digest(left), digest(right));
