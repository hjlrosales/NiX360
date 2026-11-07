import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id parameters used for new hashes. These are the OWASP baseline
 * (19 MiB, 2 iterations, 1 lane) and must be benchmarked on the DS920+ before
 * production sign-off.
 */
const HASH_OPTIONS = {
  // 2 = Argon2id in the @node-rs/argon2 binding; referenced numerically because
  // its `Algorithm` is a const enum, which verbatim-module-syntax forbids.
  algorithm: 2,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, HASH_OPTIONS);
}

export async function verifyPassword(encoded: string, password: string): Promise<boolean> {
  try {
    return await verify(encoded, password);
  } catch {
    return false;
  }
}

export function passwordProblem(password: string): string | null {
  if (typeof password !== 'string') return 'Password is required';
  if (password.length < 12) return 'Password must be at least 12 characters';
  if (password.length > 512) return 'Password must be at most 512 characters';
  return null;
}
