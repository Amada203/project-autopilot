// Safe flat YAML subset parser for Autopilot control data.
// Values are data, never sourced or executed. Rejects duplicates, unknown
// keys, and unsafe metacharacters before any consumer sees a value.

export class ParseError extends Error {
  constructor(file, key, reason) {
    super(`${file}: ${key}: ${reason}`);
    this.file = file;
    this.key = key;
  }
}

const UNSAFE = /[\n\r;|&<>`$(){}#]/;

export function parseFlatYaml(text, file, allowedKeys) {
  const result = {};
  const seen = new Set();
  for (const [index, rawLine] of text.split('\n').entries()) {
    const line = rawLine.trimEnd();
    if (line === '' || line.startsWith('#')) continue;
    const match = line.match(/^([a-z][a-z0-9_]*):[ \t]*(.*)$/);
    if (!match) throw new ParseError(file, `line ${index + 1}`, 'malformed line');
    const [, key, value] = match;
    if (!allowedKeys.includes(key)) throw new ParseError(file, key, 'unknown key');
    if (seen.has(key)) throw new ParseError(file, key, 'duplicate key');
    if (UNSAFE.test(value)) throw new ParseError(file, key, 'unsafe metacharacter');
    seen.add(key);
    result[key] = value;
  }
  for (const required of allowedKeys) {
    if (!(required in result)) throw new ParseError(file, required, 'missing required key');
  }
  return result;
}

export function parseBool(file, key, value) {
  if (value !== 'true' && value !== 'false') {
    throw new ParseError(file, key, 'must be true or false');
  }
  return value === 'true';
}

export function parseStringList(file, key, value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    throw new ParseError(file, key, 'must be a bracketed list');
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(',').map((item) => {
    let piece = item.trim();
    if (
      (piece.startsWith('"') && piece.endsWith('"')) ||
      (piece.startsWith("'") && piece.endsWith("'"))
    ) {
      piece = piece.slice(1, -1);
    }
    if (piece === '') throw new ParseError(file, key, 'contains an empty item');
    if (UNSAFE.test(piece)) throw new ParseError(file, key, `unsafe item: ${piece}`);
    return piece;
  });
}
