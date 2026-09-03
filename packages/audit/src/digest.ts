import { canonical } from './canonical';
import { type Sha256Hex, digestOfParts } from './hash';

export type { Sha256Hex };

/** Хеш значения: каноническая форма, затем SHA-256 с доменным префиксом. */
export function canonicalDigest(value: unknown): Sha256Hex {
  return digestOfParts([canonical(value)]);
}
