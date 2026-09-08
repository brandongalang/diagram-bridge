import { DiagramError } from './errors.js';

const PROTOTYPE_SENSITIVE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function assertNoPrototypePollution(obj: unknown, path = ''): void {
  if (obj === null || typeof obj !== 'object') {
    return;
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      assertNoPrototypePollution(obj[i], `${path}[${i}]`);
    }
    return;
  }

  for (const key of Object.getOwnPropertyNames(obj)) {
    if (PROTOTYPE_SENSITIVE_KEYS.has(key)) {
      throw new DiagramError(
        'VALIDATION_ERROR',
        `Prototype-sensitive key '${key}' is prohibited at ${path || 'root'}`,
        4
      );
    }
    assertNoPrototypePollution((obj as Record<string, unknown>)[key], path ? `${path}.${key}` : key);
  }
}

export function canonicalJson(value: unknown): string {
  assertNoPrototypePollution(value);

  function serialize(val: unknown): string {
    if (val === null) return 'null';
    if (typeof val === 'boolean') return val ? 'true' : 'false';
    if (typeof val === 'number') {
      if (!Number.isFinite(val)) {
        throw new DiagramError('VALIDATION_ERROR', `Non-finite number cannot be serialized: ${val}`, 4);
      }
      return val.toString();
    }
    if (typeof val === 'string') return JSON.stringify(val);
    if (Array.isArray(val)) {
      return '[' + val.map((item) => serialize(item)).join(',') + ']';
    }
    if (typeof val === 'object') {
      const keys = Object.keys(val as object).sort();
      const parts: string[] = [];
      for (const k of keys) {
        const v = (val as Record<string, unknown>)[k];
        if (v !== undefined) {
          parts.push(JSON.stringify(k) + ':' + serialize(v));
        }
      }
      return '{' + parts.join(',') + '}';
    }
    throw new DiagramError('VALIDATION_ERROR', `Unsupported data type for serialization: ${typeof val}`, 4);
  }

  return serialize(value);
}
