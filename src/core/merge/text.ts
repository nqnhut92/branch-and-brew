/** Encoding and line endings of a text file, kept so a merge result is written the way the file was. */

export type TextEncoding = 'utf8' | 'utf8bom' | 'utf16le' | 'utf16be' | 'latin1';
export type Eol = 'lf' | 'crlf';

export interface DecodedText {
  text: string;
  encoding: TextEncoding;
}

/** Files above this size, and binary files, get no editor: only take mine or take theirs. */
export const MAX_MERGE_BYTES = 2 * 1024 * 1024;

/** Git's own test: a NUL byte in the first 8000 bytes. UTF-16 text is recognised by its BOM first. */
export function isBinary(bytes: Uint8Array): boolean {
  if (hasBom(bytes, [0xff, 0xfe]) || hasBom(bytes, [0xfe, 0xff])) return false;
  return bytes.subarray(0, 8000).includes(0);
}

const hasBom = (bytes: Uint8Array, bom: number[]) => bom.every((b, i) => bytes[i] === b);

/**
 * Decodes by BOM, else as UTF-8. Bytes that are not valid UTF-8 are read as Latin-1, which maps
 * every byte to one character and back, so nothing is lost on the way out.
 */
export function decodeText(bytes: Uint8Array): DecodedText {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (hasBom(bytes, [0xef, 0xbb, 0xbf])) return { text: buffer.subarray(3).toString('utf8'), encoding: 'utf8bom' };
  if (hasBom(bytes, [0xff, 0xfe])) return { text: buffer.subarray(2).toString('utf16le'), encoding: 'utf16le' };
  if (hasBom(bytes, [0xfe, 0xff])) return { text: Buffer.from(buffer.subarray(2)).swap16().toString('utf16le'), encoding: 'utf16be' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf8' };
  } catch {
    return { text: buffer.toString('latin1'), encoding: 'latin1' };
  }
}

export function encodeText(text: string, encoding: TextEncoding): Buffer {
  switch (encoding) {
    case 'utf8': return Buffer.from(text, 'utf8');
    case 'utf8bom': return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
    case 'utf16le': return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    case 'utf16be': return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]);
    case 'latin1': return Buffer.from(text, 'latin1');
  }
}

/** The line ending most lines use; LF when there is no line break at all. */
export function detectEol(text: string): Eol {
  const crlf = text.split('\r\n').length - 1;
  const all = text.split('\n').length - 1;
  return crlf > all - crlf ? 'crlf' : 'lf';
}

export interface Lines {
  /** Lines without their line break. */
  lines: string[];
  /** The text ends with a line break. */
  finalNewline: boolean;
}

export function splitLines(text: string): Lines {
  if (text === '') return { lines: [], finalNewline: true };
  const lines = text.split(/\r\n|\n/);
  const finalNewline = lines[lines.length - 1] === '';
  if (finalNewline) lines.pop();
  return { lines, finalNewline };
}

export function joinLines(lines: readonly string[], eol: Eol, finalNewline: boolean): string {
  const separator = eol === 'crlf' ? '\r\n' : '\n';
  return lines.length ? lines.join(separator) + (finalNewline ? separator : '') : '';
}
