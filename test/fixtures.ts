/**
 * 按字节手工构造的 JPEG/EXIF 夹具。
 * 布局固定，关键偏移在构造时记录，测试中另有手工计算的锚点断言，
 * 不依赖被测解析器来验证自身。
 */

export interface EntrySpec {
  tag: number;
  type: number;
  count: number;
  /** 内联数值（SHORT/LONG/BYTE），或外置值的 Buffer */
  inline?: number[];
  external?: Buffer;
  /** 强制把外置偏移写成该值（用于构造坏指针） */
  forcedOffset?: number;
}

export interface BuiltJpeg {
  buf: Buffer;
  tiffStart: number;
  exifIfdOffset: number; // 绝对偏移
  /** tag -> { entryOffset, valueOffset, valueLength } */
  positions: Map<number, { entryOffset: number; valueOffset: number; valueLength: number }>;
}

const TYPE_SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 };

function ascii(s: string): Buffer {
  return Buffer.from(s + "\0", "latin1");
}

export function buildExifJpeg(endian: "LE" | "BE", opts: { zeroDenominator?: boolean } = {}): BuiltJpeg {
  const little = endian === "LE";
  const parts: Buffer[] = [];
  const positions = new Map<number, { entryOffset: number; valueOffset: number; valueLength: number }>();

  // SOI
  parts.push(Buffer.from([0xff, 0xd8]));
  // APP0 JFIF（16 字节负载）
  const app0 = Buffer.from("JFIF\0\x01\x02\0\0\x01\0\x01\0\0", "latin1");
  parts.push(Buffer.from([0xff, 0xe0, 0x00, 0x10]));
  parts.push(app0);
  // 非 EXIF 的 APP1（XMP），应被跳过
  const xmp = Buffer.from("http://ns.adobe.com/xap/1.0/\0", "latin1");
  const xmpHead = Buffer.alloc(4);
  xmpHead[0] = 0xff;
  xmpHead[1] = 0xe1;
  xmpHead.writeUInt16BE(xmp.length + 2, 2);
  parts.push(xmpHead, xmp);

  // APP1 Exif
  const prefixLen = parts.reduce((n, b) => n + b.length, 0);
  const exifDataStart = prefixLen + 4;
  const tiffStart = exifDataStart + 6;

  const w16 = (v: number): Buffer => {
    const b = Buffer.alloc(2);
    if (little) b.writeUInt16LE(v);
    else b.writeUInt16BE(v);
    return b;
  };
  const w32 = (v: number): Buffer => {
    const b = Buffer.alloc(4);
    if (little) b.writeUInt32LE(v);
    else b.writeUInt32BE(v);
    return b;
  };

  const ifd0Entries: EntrySpec[] = [
    { tag: 0x010f, type: 2, count: 8, external: ascii("TestCam") },
    { tag: 0x0110, type: 2, count: 8, external: ascii("Model X") },
    { tag: 0x0112, type: 3, count: 1, inline: [6] },
    { tag: 0x0132, type: 2, count: 20, external: ascii("2024:01:02 03:04:05") },
    { tag: 0x8769, type: 4, count: 1, inline: [0] }, // 稍后回填
  ];
  const exposure = Buffer.alloc(8);
  if (little) {
    exposure.writeUInt32LE(1, 0);
    exposure.writeUInt32LE(opts.zeroDenominator ? 0 : 125, 4);
  } else {
    exposure.writeUInt32BE(1, 0);
    exposure.writeUInt32BE(opts.zeroDenominator ? 0 : 125, 4);
  }
  const exifIfdEntries: EntrySpec[] = [
    { tag: 0x9003, type: 2, count: 20, external: ascii("2024:01:02 03:04:06") },
    { tag: 0x829a, type: 5, count: 1, external: exposure },
    { tag: 0xa002, type: 4, count: 1, inline: [4000] },
    { tag: 0xa003, type: 4, count: 1, inline: [3000] },
  ];

  // 布局：TIFF 头(8) + IFD0(2 + 5*12 + 4) + IFD0 外置值 + ExifIFD(2 + 4*12 + 4) + ExifIFD 外置值
  const ifd0Rel = 8;
  const ifd0Size = 2 + ifd0Entries.length * 12 + 4;
  let cursor = ifd0Rel + ifd0Size;
  const externals0 = new Map<number, number>(); // entryIndex -> relOffset
  for (let i = 0; i < ifd0Entries.length; i++) {
    const e = ifd0Entries[i];
    if (e.external) {
      externals0.set(i, cursor);
      cursor += e.external.length;
    }
  }
  const exifIfdRel = cursor;
  const exifIfdSize = 2 + exifIfdEntries.length * 12 + 4;
  cursor = exifIfdRel + exifIfdSize;
  const externals1 = new Map<number, number>();
  for (let i = 0; i < exifIfdEntries.length; i++) {
    const e = exifIfdEntries[i];
    if (e.external) {
      externals1.set(i, cursor);
      cursor += e.external.length;
    }
  }
  const tiffLen = cursor;

  const tiff = Buffer.alloc(tiffLen);
  tiff.set(little ? [0x49, 0x49] : [0x4d, 0x4d], 0);
  w16(42).copy(tiff, 2);
  w32(ifd0Rel).copy(tiff, 4);

  const writeIfd = (entries: EntrySpec[], rel: number, externals: Map<number, number>) => {
    w16(entries.length).copy(tiff, rel);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const entryRel = rel + 2 + i * 12;
      w16(e.tag).copy(tiff, entryRel);
      w16(e.type).copy(tiff, entryRel + 2);
      w32(e.count).copy(tiff, entryRel + 4);
      const size = TYPE_SIZES[e.type] * e.count;
      let valueRel: number;
      if (e.external) {
        valueRel = externals.get(i)!;
        w32(e.forcedOffset ?? valueRel).copy(tiff, entryRel + 8);
        tiff.set(e.external, valueRel);
      } else {
        valueRel = entryRel + 8;
        const vals = e.inline!;
        if (e.type === 3) vals.forEach((v, j) => w16(v).copy(tiff, valueRel + j * 2));
        else if (e.type === 4) vals.forEach((v, j) => w32(v).copy(tiff, valueRel + j * 4));
        else vals.forEach((v, j) => (tiff[valueRel + j] = v));
      }
      positions.set(e.tag, {
        entryOffset: tiffStart + entryRel,
        valueOffset: tiffStart + valueRel,
        valueLength: size,
      });
    }
    w32(0).copy(tiff, rel + 2 + entries.length * 12); // next IFD = 0
  };

  // 回填 ExifIFD 指针
  ifd0Entries[4].inline = [exifIfdRel];
  writeIfd(ifd0Entries, ifd0Rel, externals0);
  writeIfd(exifIfdEntries, exifIfdRel, externals1);

  const exifHead = Buffer.alloc(4);
  exifHead[0] = 0xff;
  exifHead[1] = 0xe1;
  const exifPayload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  exifHead.writeUInt16BE(exifPayload.length + 2, 2);
  parts.push(exifHead, exifPayload);

  // SOS（空扫描数据）+ EOI
  parts.push(Buffer.from([0xff, 0xda, 0x00, 0x02]));
  parts.push(Buffer.from([0xff, 0xd9]));

  return {
    buf: Buffer.concat(parts),
    tiffStart,
    exifIfdOffset: tiffStart + exifIfdRel,
    positions,
  };
}

/** 无 EXIF 的正常 JPEG */
export function buildNoExifJpeg(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x10]),
    Buffer.from("JFIF\0\x01\x02\0\0\x01\0\x01\0\0", "latin1"),
    Buffer.from([0xff, 0xda, 0x00, 0x02]),
    Buffer.from([0xff, 0xd9]),
  ]);
}
