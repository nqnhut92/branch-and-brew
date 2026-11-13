import { describe, expect, it } from 'vitest';
import { decodeText, detectEol, encodeText, isBinary, joinLines, splitLines, type TextEncoding } from './text';

describe('encoding', () => {
  it('round-trips every supported encoding byte for byte', () => {
    const samples: [TextEncoding, Buffer][] = [
      ['utf8', Buffer.from('héllo ü\n', 'utf8')],
      ['utf8bom', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('héllo\n', 'utf8')])],
      ['utf16le', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('héllo\r\n', 'utf16le')])],
      ['utf16be', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('hé\n', 'utf16le').swap16()])],
      ['latin1', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])], // "café" in Windows-1252: not valid UTF-8
    ];
    for (const [encoding, bytes] of samples) {
      const decoded = decodeText(bytes);
      expect(decoded.encoding).toBe(encoding);
      expect(decoded.text.replace(/\r?\n/, '')).toMatch(/^(h.+|café)$/);
      expect(encodeText(decoded.text, decoded.encoding).equals(bytes), encoding).toBe(true);
    }
  });

  it('tells binary from text', () => {
    expect(isBinary(Buffer.from('plain\n'))).toBe(false);
    expect(isBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))).toBe(true);
    expect(isBinary(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a\n', 'utf16le')]))).toBe(false);
  });
});

describe('lines', () => {
  it('detects the dominant line ending', () => {
    expect(detectEol('a\r\nb\r\nc\n')).toBe('crlf');
    expect(detectEol('a\nb\nc\r\n')).toBe('lf');
    expect(detectEol('no break')).toBe('lf');
  });

  it('splits and joins without losing the final line break', () => {
    expect(splitLines('a\r\nb\r\n')).toEqual({ lines: ['a', 'b'], finalNewline: true });
    expect(splitLines('a\nb')).toEqual({ lines: ['a', 'b'], finalNewline: false });
    expect(splitLines('')).toEqual({ lines: [], finalNewline: true });
    expect(splitLines('\n')).toEqual({ lines: [''], finalNewline: true });
    expect(joinLines(['a', 'b'], 'crlf', true)).toBe('a\r\nb\r\n');
    expect(joinLines(['a', 'b'], 'lf', false)).toBe('a\nb');
    expect(joinLines([], 'crlf', true)).toBe('');
    for (const text of ['a\nb\n', 'a\nb', '\n', 'x']) {
      const s = splitLines(text);
      expect(joinLines(s.lines, 'lf', s.finalNewline)).toBe(text);
    }
  });
});
