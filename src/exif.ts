// JPEG marker scan + EXIF (TIFF subset) parser core. Read-only.
export const PARSER_VERSION = "1.0.0";

// Safety limits against unbounded allocation on corrupt files
export const LIMITS = {
  maxSegments: 512,
  maxEntriesPerIfd: 512,
  maxCount: 1 << 20,
  maxValueBytes: 4 << 20,
};

export interface ExifError {
  code: string;
  message: string;
  segmentOffset?: number;
  fileOffset?: number;
}

export class ParseError extends Error {
  code: string;
  segmentOffset?: number;
  fileOffset?: number;
  constructor(e: ExifError) {
    super(e.message);
    this.code = e.code;
    this.segmentOffset = e.segmentOffset;
    this.fileOffset = e.fileOffset;
  }
}

export interface SegmentInfo {
  marker: number;
  name: string;
  offset: number; // file offset of the 0xFF marker byte
  length: number; // payload length (excludes marker and length field)
  isExif: boolean;
}

const MARKER_NAMES: Record<number, string> = {
  0xd8: "SOI", 0xd9: "EOI", 0xda: "SOS",
  0xe0: "APP0", 0xe1: "APP1", 0xe2: "APP2",
  0xdb: "DQT", 0xc4: "DHT", 0xc0: "SOF0", 0xc2: "SOF2",
  0xdd: "DRI", 0xfe: "COM",
};

const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

// Scan JPEG markers; stop at SOS so compressed scan data is never parsed as markers.
export function scanSegments(buf: Buffer): SegmentInfo[] {
  if (buf.length < 2 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    throw new ParseError({ code: "NOT_JPEG", message: "not a JPEG (missing SOI)", fileOffset: 0 });
  }
  const segs: SegmentInfo[] = [];
  let pos = 2;
  while (pos < buf.length) {
    if (segs.length >= LIMITS.maxSegments) {
      throw new ParseError({ code: "LIMIT_EXCEEDED", message: "segment count exceeds limit", fileOffset: pos });
    }
    if (buf[pos] !== 0xff) {
      throw new ParseError({ code: "TRUNCATED", message: "expected 0xFF marker byte", fileOffset: pos });
    }
    while (pos < buf.length && buf[pos] === 0xff) pos++; // skip fill bytes
    if (pos >= buf.length) break;
    const marker = buf[pos];
    const markerOffset = pos - 1;
    // standalone markers without a length field
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      if (marker === 0xd9) break; // EOI
      pos++;
      continue;
    }
    if (pos + 3 > buf.length) {
      throw new ParseError({ code: "TRUNCATED", message: "segment length field truncated", fileOffset: markerOffset });
    }
    const segLen = buf.readUInt16BE(pos + 1); // includes its own 2 bytes
    if (segLen < 2) {
      throw new ParseError({ code: "BAD_SEGMENT_LENGTH", message: "invalid segment length", fileOffset: markerOffset });
    }
    const dataStart = pos + 3;
    const dataLen = segLen - 2;
    if (dataStart + dataLen > buf.length) {
      throw new ParseError({ code: "TRUNCATED", message: "segment payload truncated", fileOffset: markerOffset });
    }
    if (marker === 0xda) {
      segs.push({ marker, name: "SOS", offset: markerOffset, length: dataLen, isExif: false });
      break; // compressed scan data follows; stop scanning
    }
    let isExif = false;
    if (marker === 0xe1 && dataLen >= 6) {
      isExif = EXIF_HEADER.every((b, i) => buf[dataStart + i] === b);
    }
    segs.push({
      marker,
      name: MARKER_NAMES[marker] ?? `0xFF${marker.toString(16).toUpperCase().padStart(2, "0")}`,
      offset: markerOffset,
      length: dataLen,
      isExif,
    });
    pos = dataStart + dataLen;
  }
  return segs;
}

export const TYPE_NAMES: Record<number, string> = { 1: "BYTE", 2: "ASCII", 3: "SHORT", 4: "LONG", 5: "RATIONAL" };
export const TYPE_SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 };

export interface TagEntry {
  tag: number;
  tagHex: string;
  ifd: string;
  type: number;
  typeName: string;
  count: number;
  inline: boolean;
  valueOffset: number; // absolute file offset of value bytes
  valueLength: number; // value byte length
  entryOffset: number; // absolute file offset of the 12-byte directory entry
  raw: number[] | string | { numerator: number; denominator: number }[];
  error?: ExifError;
}

interface Ctx {
  buf: Buffer;
  tiffStart: number; // absolute file offset of TIFF header
  segOffset: number;
  little: boolean;
}

function u16(ctx: Ctx, off: number): number {
  return ctx.little ? ctx.buf.readUInt16LE(off) : ctx.buf.readUInt16BE(off);
}
function u32(ctx: Ctx, off: number): number {
  return ctx.little ? ctx.buf.readUInt32LE(off) : ctx.buf.readUInt32BE(off);
}

function readEntry(ctx: Ctx, ifdName: string, entryOffset: number): TagEntry {
  const { buf, tiffStart, segOffset } = ctx;
  const tag = u16(ctx, entryOffset);
  const type = u16(ctx, entryOffset + 2);
  const count = u32(ctx, entryOffset + 4);
  const base: TagEntry = {
    tag,
    tagHex: "0x" + tag.toString(16).toUpperCase().padStart(4, "0"),
    ifd: ifdName,
    type,
    typeName: TYPE_NAMES[type] ?? `UNKNOWN(${type})`,
    count,
    inline: false,
    valueOffset: 0,
    valueLength: 0,
    entryOffset,
    raw: [],
  };
  const fail = (e: ExifError): TagEntry => {
    base.error = e;
    return base;
  };
  const size = TYPE_SIZES[type];
  if (size === undefined) {
    return fail({ code: "UNKNOWN_TYPE", message: `unknown field type ${type}`, segmentOffset: segOffset, fileOffset: entryOffset + 2 });
  }
  if (count > LIMITS.maxCount) {
    return fail({ code: "COUNT_TOO_LARGE", message: `count ${count} exceeds limit`, segmentOffset: segOffset, fileOffset: entryOffset + 4 });
  }
  const valueBytes = size * count; // count is element count, not bytes
  if (valueBytes > LIMITS.maxValueBytes) {
    return fail({ code: "COUNT_TOO_LARGE", message: `value byte size ${valueBytes} exceeds limit`, segmentOffset: segOffset, fileOffset: entryOffset + 4 });
  }
  base.valueLength = valueBytes;
  let valueOff: number;
  if (valueBytes <= 4) {
    base.inline = true; // value stored inside the entry itself
    valueOff = entryOffset + 8;
  } else {
    const rel = u32(ctx, entryOffset + 8); // offset relative to TIFF start, not file start
    valueOff = tiffStart + rel;
  }
  base.valueOffset = valueOff;
  if (valueOff < 0 || valueOff + valueBytes > buf.length) {
    return fail({
      code: "VALUE_OUT_OF_RANGE",
      message: `value range [${valueOff}, ${valueOff + valueBytes}) out of bounds (file ${buf.length} bytes)`,
      segmentOffset: segOffset,
      fileOffset: valueOff,
    });
  }
  switch (type) {
    case 1:
      base.raw = Array.from(buf.subarray(valueOff, valueOff + count));
      break;
    case 2:
      base.raw = buf.toString("latin1", valueOff, valueOff + valueBytes);
      break;
    case 3: {
      const out: number[] = [];
      for (let i = 0; i < count; i++) out.push(u16(ctx, valueOff + i * 2));
      base.raw = out;
      break;
    }
    case 4: {
      const out: number[] = [];
      for (let i = 0; i < count; i++) out.push(u32(ctx, valueOff + i * 4));
      base.raw = out;
      break;
    }
    case 5: {
      const out: { numerator: number; denominator: number }[] = [];
      for (let i = 0; i < count; i++) {
        out.push({ numerator: u32(ctx, valueOff + i * 8), denominator: u32(ctx, valueOff + i * 8 + 4) });
      }
      base.raw = out;
      break;
    }
  }
  return base;
}

export interface IfdResult {
  name: string;
  offset: number;
  entries: TagEntry[];
}

export interface ExifParseResult {
  byteOrder: "II" | "MM";
  tiffStart: number;
  segmentOffset: number;
  ifds: IfdResult[];
  tags: TagEntry[];
  errors: ExifError[];
}

function parseIfd(ctx: Ctx, name: string, ifdOffset: number, visited: Set<number>): IfdResult {
  const { buf, segOffset } = ctx;
  if (visited.has(ifdOffset)) {
    throw new ParseError({ code: "POINTER_CYCLE", message: `IFD pointer cycle at offset ${ifdOffset}`, segmentOffset: segOffset, fileOffset: ifdOffset });
  }
  visited.add(ifdOffset);
  if (ifdOffset + 2 > buf.length) {
    throw new ParseError({ code: "OFFSET_OUT_OF_RANGE", message: `IFD offset ${ifdOffset} out of bounds`, segmentOffset: segOffset, fileOffset: ifdOffset });
  }
  const count = u16(ctx, ifdOffset);
  if (count > LIMITS.maxEntriesPerIfd) {
    throw new ParseError({ code: "LIMIT_EXCEEDED", message: `IFD entry count ${count} exceeds limit`, segmentOffset: segOffset, fileOffset: ifdOffset });
  }
  const entriesStart = ifdOffset + 2;
  if (entriesStart + count * 12 > buf.length) {
    throw new ParseError({ code: "ENTRY_OUT_OF_RANGE", message: `IFD entry area out of bounds (${count} entries)`, segmentOffset: segOffset, fileOffset: ifdOffset });
  }
  const entries: TagEntry[] = [];
  for (let i = 0; i < count; i++) {
    entries.push(readEntry(ctx, name, entriesStart + i * 12));
  }
  return { name, offset: ifdOffset, entries };
}

// Parse one EXIF APP1 segment (must already be verified to start with "Exif\0\0").
export function parseExifSegment(buf: Buffer, seg: SegmentInfo): ExifParseResult {
  const segDataStart = seg.offset + 4; // skip 0xFF, marker, 2-byte length
  const tiffStart = segDataStart + 6; // skip "Exif\0\0"
  if (tiffStart + 8 > buf.length) {
    throw new ParseError({ code: "BAD_TIFF_HEADER", message: "TIFF header truncated", segmentOffset: seg.offset, fileOffset: tiffStart });
  }
  const bo = buf.toString("latin1", tiffStart, tiffStart + 2);
  let little: boolean;
  let byteOrder: "II" | "MM";
  if (bo === "II") { little = true; byteOrder = "II"; }
  else if (bo === "MM") { little = false; byteOrder = "MM"; }
  else {
    throw new ParseError({ code: "BAD_BYTE_ORDER", message: `invalid byte order mark "${bo}"`, segmentOffset: seg.offset, fileOffset: tiffStart });
  }
  const ctx: Ctx = { buf, tiffStart, segOffset: seg.offset, little };
  const magic = u16(ctx, tiffStart + 2);
  if (magic !== 42) {
    throw new ParseError({ code: "BAD_TIFF_HEADER", message: `TIFF magic should be 42, got ${magic}`, segmentOffset: seg.offset, fileOffset: tiffStart + 2 });
  }
  const ifd0Rel = u32(ctx, tiffStart + 4);
  const ifd0Off = tiffStart + ifd0Rel;
  const visited = new Set<number>();
  const ifds: IfdResult[] = [];
  const errors: ExifError[] = [];

  const ifd0 = parseIfd(ctx, "IFD0", ifd0Off, visited);
  ifds.push(ifd0);

  // Follow only the ExifIFD pointer (0x8769); do not expand GPS/MakerNote/thumbnail.
  const exifPtr = ifd0.entries.find((e) => e.tag === 0x8769 && !e.error);
  if (exifPtr) {
    if (exifPtr.type !== 4 || exifPtr.count !== 1) {
      errors.push({ code: "BAD_POINTER", message: "ExifIFD pointer entry has invalid type/count", segmentOffset: seg.offset, fileOffset: exifPtr.entryOffset });
    } else {
      const rel = (exifPtr.raw as number[])[0];
      const subOff = tiffStart + rel;
      try {
        ifds.push(parseIfd(ctx, "ExifIFD", subOff, visited));
      } catch (e) {
        if (e instanceof ParseError) {
          errors.push({ code: e.code, message: e.message, segmentOffset: e.segmentOffset, fileOffset: e.fileOffset });
        } else throw e;
      }
    }
  }

  const tags = ifds.flatMap((d) => d.entries);
  return { byteOrder, tiffStart, segmentOffset: seg.offset, ifds, tags, errors };
}

export interface FileReport {
  parserVersion: string;
  byteOrder?: "II" | "MM";
  segments: SegmentInfo[];
  exif?: ExifParseResult;
  status: "ok" | "no_exif" | "error";
  errors: ExifError[];
}

export function parseFile(buf: Buffer): FileReport {
  const report: FileReport = { parserVersion: PARSER_VERSION, segments: [], status: "ok", errors: [] };
  let segs: SegmentInfo[];
  try {
    segs = scanSegments(buf);
  } catch (e) {
    if (e instanceof ParseError) {
      report.status = "error";
      report.errors.push({ code: e.code, message: e.message, segmentOffset: e.segmentOffset, fileOffset: e.fileOffset });
      return report;
    }
    throw e;
  }
  report.segments = segs;
  const exifSeg = segs.find((s) => s.isExif);
  if (!exifSeg) {
    report.status = "no_exif"; // valid JPEG without EXIF is not corruption
    return report;
  }
  try {
    report.exif = parseExifSegment(buf, exifSeg);
    report.byteOrder = report.exif.byteOrder;
    report.errors = report.exif.errors;
    if (report.errors.length > 0) report.status = "error";
  } catch (e) {
    if (e instanceof ParseError) {
      report.status = "error";
      report.errors.push({ code: e.code, message: e.message, segmentOffset: e.segmentOffset, fileOffset: e.fileOffset });
    } else throw e;
  }
  return report;
}
