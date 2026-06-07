/**
 * validation.ts — Shared validation functions for config and setup.
 *
 * Centralises input validation patterns used across config.ts and setup.ts
 * to ensure consistent rules and reduce duplication.
 */

import { API_KEY_PREFIX, MIN_KEY_LENGTH, WORKSPACE_ID_REGEX } from './constants.js';

/**
 * Check if the given value is a valid TCP port number (1–65535).
 */
export function isValidPort(value: unknown): value is number {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return false;
    value = Number.parseInt(trimmed, 10);
  }
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * Check if the given string looks like a valid API key.
 * Must start with `sk-` and be at least {@link MIN_KEY_LENGTH} characters long.
 */
export function isValidApiKey(key: unknown): key is string {
  return typeof key === 'string' && key.startsWith(API_KEY_PREFIX) && key.length >= MIN_KEY_LENGTH;
}

/**
 * Check if the given value is a valid HTTPS URL.
 * SSRF prevention: only HTTPS URLs are accepted.
 */
export function isValidHttpsUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Check if the given string is a valid positive integer within an optional range.
 * Trims whitespace before parsing.
 *
 * @param val - The string value to check.
 * @param min - Minimum accepted value (default: 1).
 * @param max - Maximum accepted value (default: 100).
 * @returns `true` if the value is a positive integer in the given range.
 */
export function isValidPositiveInt(val: string, min = 1, max = 100): boolean {
  const trimmed = val.trim();
  if (!/^\d+$/.test(trimmed)) return false;
  const n = Number.parseInt(trimmed, 10);
  return n >= min && n <= max;
}

/**
 * Check if the given string is a valid workspace ID (matches `wrk_[A-Za-z0-9]+`).
 */
export function isValidWorkspaceId(id: unknown): id is string {
  return typeof id === 'string' && WORKSPACE_ID_REGEX.test(id);
}
