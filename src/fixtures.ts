// Byte-level synthetic JPEG fixture builder. Used by tests and the demo.
// Layout is deterministic so tests can assert hardcoded file offsets.
//
// File layout (offsets in decimal):
//   0   SOI
//   2   APP0 (JFIF, payload 16, total 20)
//   22  APP1 non-EXIF (payload 8, total 12)
//   34  APP1 EXIF: marker@34 len@36 payload@38 "Exif\0\0" TIFF@44
//       TIFF: header 8B, IFD0@52 (5 entries), ExifIFD@118 (4 entries),
//       external data from 172.
//   then SOS with fake scan data containing 0xFF bytes, then EOI.

export interface FixtureOptions {
  byteOrder?: "II" | "MM";
  orientation?: number;
  exposureNum?: number;
  exposureDen?: number;
  makeOffsetOverride?: number;   // force a bad value offset
  makeCountOverride?: number;    // force a huge count
  makeTypeOverride?: number;     // force an unknown type
  exifPtrTarget?: number;        // override ExifIFD pointer (TIFF-relative)
  badByteOrder?: boolean;
  badMagic?: boolean;
  skipExif?: boolean;            // valid JPEG without EXIF
  truncateAt?: number;           // cut the file here
}

export interface Fixture {
  buf: Buffer;
  tiffStart: number;
  offsets: {
    app0: number;
    app1Xmp: number;
    app1Exif: number;
    ifd0: number;
    ifd0Entries: number;
    exifIfd: number;
    exifIfdEntries: number;
    makeValue: number;
    modelValue: number;
    dateTimeValue: number;
    exposureValue: number;
    dateTimeOriginalValue: number;
    sos: number;
  };
}

const MAKE = "TestCam\0";
const MODEL = "Model X\0";
const DATETIME = "2024:01:02 03:04:05\0";
const DATETIME_ORIG = "2024:01:02 03:04:06\0";

export function buildFixture(opts: FixtureOptions = {}): Fixture {
  const little = (opts.byteOrder ?? "II") === "II";
  const orientation = opts.orientation ?? 6;
  const exposureNum = opts.exposureNum ?? 1;
  const exposureDen = opts.exposureDen ?? 125;

  // TIFF-relative layout constants
  const IFD0_REL = 8;
  const IFD0_COUNT = 5;
  const EXIF_IFD_REL = IFD0_REL + 2 + IFD0_COUNT * 12 + 4; // 74
  const EXIF_COUNT = 4;
  const DATA_REL = EXIF_IFD_REL + 2 + EXIF_COUNT * 12 + 4; // 128

  const makeRel = DATA_REL;                    // 128, 8 bytes
  const modelRel = makeRel + 8;                // 136
  const dateTimeRel = modelRel + 8;            // 144, 20 bytes
  const exposureRel = dateTimeRel + 20;        // 164, 8 bytes
  const dateTimeOrigRel = exposureRel + 8;     // 172, 20 bytes
  const tiffLen = dateTimeOrigRel + 20;        // 192

  const tiff = Buffer.alloc(tiffLen);
  const w16 = (off: number, v: number) => little ? tiff.writeUInt16LE(v, off) : tiff.writeUInt16BE(v, off);
  const w32 = (off: number, v: number) => little ? tiff.writeUInt32LE(v, off) : tiff.writeUInt32BE(v, off);

  tiff.write(opts.badByteOrder ? "ZZ" : little ? "II" : "MM", 0, "latin1");
  w16(2, opts.badMagic ? 99 : 42);
  w32(4, IFD0_REL);

  // IFD0 entries (sorted by tag)
  w16(IFD0_REL, IFD0_COUNT);
  let e = IFD0_REL + 2;
  const entry = (tag: number, type: number, count: number, valueOrOffset: number, inlineBytes?: Buffer) => {
    w16(e, tag); w16(e + 2, type); w32(e + 4, count);
    if (inlineBytes) inlineBytes.copy(tiff, e + 8);
    else w32(e + 8, valueOrOffset);
    e += 12;
  };
  const shortInline = (v: number) => {
    const b = Buffer.alloc(4);
    if (little) b.writeUInt16LE(v, 0); else b.writeUInt16BE(v, 0);
    return b;
  };
  const longInline = (v: number) => {
    const b = Buffer.alloc(4);
    if (little) b.writeUInt32LE(v, 0); else b.writeUInt32BE(v, 0);
    return b;
  };

  entry(0x010f, opts.makeTypeOverride ?? 2, opts.makeCountOverride ?? 8, opts.makeOffsetOverride ?? makeRel);
  entry(0x0110, 2, 8, modelRel);
  entry(0x0112, 3, 1, 0, shortInline(orientation));
  entry(0x0132, 2, 20, dateTimeRel);
  entry(0x8769, 4, 1, 0, longInline(opts.exifPtrTarget ?? EXIF_IFD_REL));
  w32(e, 0); // next IFD = 0

  // ExifIFD entries
  w16(EXIF_IFD_REL, EXIF_COUNT);
  e = EXIF_IFD_REL + 2;
  entry(0x829a, 5, 1, exposureRel);
  entry(0x9003, 2, 20, dateTimeOrigRel);
  entry(0xa002, 4, 1, 0, longInline(4000));
  entry(0xa003, 4, 1, 0, longInline(3000));
  w32(e, 0);

  tiff.write(MAKE, makeRel, "latin1");
  tiff.write(MODEL, modelRel, "latin1");
  tiff.write(DATETIME, dateTimeRel, "latin1");
  w32(exposureRel, exposureNum);
  w32(exposureRel + 4, exposureDen);
  tiff.write(DATETIME_ORIG, dateTimeOrigRel, "latin1");

  // Assemble JPEG
  const parts: Buffer[] = [];
  parts.push(Buffer.from([0xff, 0xd8])); // SOI
  const app0Payload = Buffer.concat([Buffer.from("JFIF\0", "latin1"), Buffer.alloc(11)]);
  parts.push(Buffer.from([0xff, 0xe0, 0x00, 0x12])); // len = 18
  parts.push(app0Payload);
  const xmpPayload = Buffer.from("XMP:XMP!", "latin1"); // 8 bytes, non-EXIF APP1
  parts.push(Buffer.from([0xff, 0xe1, 0x00, 0x0a]));
  parts.push(xmpPayload);

  const offsets: Fixture["offsets"] = {
    app0: 2,
    app1Xmp: 22,
    app1Exif: 34,
    ifd0: 44 + IFD0_REL,
    ifd0Entries: 44 + IFD0_REL + 2,
    exifIfd: 44 + EXIF_IFD_REL,
    exifIfdEntries: 44 + EXIF_IFD_REL + 2,
    makeValue: 44 + makeRel,
    modelValue: 44 + modelRel,
    dateTimeValue: 44 + dateTimeRel,
    exposureValue: 44 + exposureRel,
    dateTimeOriginalValue: 44 + dateTimeOrigRel,
    sos: 0,
  };

  if (!opts.skipExif) {
    const exifPayload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
    const len = exifPayload.length + 2;
    const head = Buffer.from([0xff, 0xe1, (len >> 8) & 0xff, len & 0xff]);
    parts.push(head, exifPayload);
  }

  let soFar = parts.reduce((n, b) => n + b.length, 0);
  offsets.sos = soFar;
  // Minimal SOS segment then fake scan data with 0xFF bytes that must NOT be parsed as markers
  const sosPayload = Buffer.from([0x01, 0x01, 0x00]); // 1 component
  parts.push(Buffer.from([0xff, 0xda, 0x00, 0x05]), sosPayload);
  parts.push(Buffer.from([0x11, 0xff, 0x00, 0x22, 0xff, 0xe1, 0x33])); // scan data incl. fake FF E1
  parts.push(Buffer.from([0xff, 0xd9])); // EOI

  let buf = Buffer.concat(parts);
  if (opts.truncateAt !== undefined) buf = buf.subarray(0, opts.truncateAt);
  return { buf, tiffStart: 44, offsets };
}
