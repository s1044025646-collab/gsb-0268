import { ExifError } from "./errors";
import type { Segment } from "./jpeg";

export const MAX_IFDS = 8;
export const MAX_ENTRIES_PER_IFD = 512;
export const MAX_FIELD_COUNT = 1_000_000;

export const TYPE_SIZES: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
};

export const TYPE_NAMES: Record<number, string> = {
  1: "BYTE",
  2: "ASCII",
  3: "SHORT",
  4: "LONG",
  5: "RATIONAL",
};

export interface Rational {
  num: number;
  den: number;
}

export interface RawTag {
  tag: number;
  ifd: string;
  type: number;
  typeName: string | null;
  count: number;
  inline: boolean;
  /** 条目在文件中的绝对偏移（12 字节条目起点） */
  entryOffset: number;
  /** 值字节的绝对偏移（内联时为条目内 4 字节值区起点） */
  valueOffset: number;
  /** 值占用的字节数 */
  valueLength: number;
  /** 原始值：number[] | string | Rational[]；未知类型为 null */
  value: number[] | string | Rational[] | null;
  diagnostics: string[];
}

export interface ParsedExif {
  endian: "LE" | "BE";
  /** TIFF 头在文件中的绝对偏移 */
  tiffStart: number;
  tags: RawTag[];
  visitedIfds: number[];
}

class Reader {
  constructor(public buf: Buffer, public little: boolean) {}
  u16(off: number): number {
    return this.little ? this.buf.readUInt16LE(off) : this.buf.readUInt16BE(off);
  }
  u32(off: number): number {
    return this.little ? this.buf.readUInt32LE(off) : this.buf.readUInt32BE(off);
  }
}

function readValues(
  r: Reader,
  type: number,
  count: number,
  valueOffset: number,
  diagnostics: string[]
): number[] | string | Rational[] | null {
  switch (type) {
    case 1: {
      const out: number[] = [];
      for (let i = 0; i < count; i++) out.push(r.buf[valueOffset + i]);
      return out;
    }
    case 2:
      // 保留原始文本（latin1 逐字节映射，不做编码猜测）
      return r.buf.toString("latin1", valueOffset, valueOffset + count);
    case 3: {
      const out: number[] = [];
      for (let i = 0; i < count; i++) out.push(r.u16(valueOffset + i * 2));
      return out;
    }
    case 4: {
      const out: number[] = [];
      for (let i = 0; i < count; i++) out.push(r.u32(valueOffset + i * 4));
      return out;
    }
    case 5: {
      const out: Rational[] = [];
      for (let i = 0; i < count; i++) {
        const num = r.u32(valueOffset + i * 8);
        const den = r.u32(valueOffset + i * 8 + 4);
        if (den === 0) {
          diagnostics.push(`第 ${i} 个有理数分母为零，数值无效`);
        }
        out.push({ num, den });
      }
      return out;
    }
    default:
      return null;
  }
}

function parseIfd(
  r: Reader,
  ifdOffsetAbs: number,
  ifdName: string,
  seg: Segment,
  tiffStart: number,
  tags: RawTag[]
): void {
  const segName = "APP1(Exif)";
  if (ifdOffsetAbs + 2 > seg.dataEnd) {
    throw new ExifError(
      "E_TRUNCATED",
      `${ifdName} 计数字段越出 APP1 段（需要偏移 ${ifdOffsetAbs}，段结束于 ${seg.dataEnd}）`,
      segName,
      ifdOffsetAbs
    );
  }
  const count = r.u16(ifdOffsetAbs);
  if (count > MAX_ENTRIES_PER_IFD) {
    throw new ExifError(
      "E_LIMIT",
      `${ifdName} 条目数 ${count} 超过上限 ${MAX_ENTRIES_PER_IFD}`,
      segName,
      ifdOffsetAbs
    );
  }
  const entriesStart = ifdOffsetAbs + 2;
  const entriesEnd = entriesStart + count * 12;
  if (entriesEnd + 4 > seg.dataEnd) {
    throw new ExifError(
      "E_TRUNCATED",
      `${ifdName} 声明 ${count} 个条目，目录区越出 APP1 段（需要到 ${entriesEnd + 4}，段结束于 ${seg.dataEnd}）`,
      segName,
      ifdOffsetAbs
    );
  }
  for (let i = 0; i < count; i++) {
    const entryOffset = entriesStart + i * 12;
    const tag = r.u16(entryOffset);
    const type = r.u16(entryOffset + 2);
    const fieldCount = r.u32(entryOffset + 4);
    const diagnostics: string[] = [];
    const typeName = TYPE_NAMES[type] ?? null;
    if (typeName === null) {
      diagnostics.push(`未知字段类型 ${type}，跳过值读取`);
      tags.push({
        tag,
        ifd: ifdName,
        type,
        typeName: null,
        count: fieldCount,
        inline: false,
        entryOffset,
        valueOffset: entryOffset + 8,
        valueLength: 0,
        value: null,
        diagnostics,
      });
      continue;
    }
    if (fieldCount > MAX_FIELD_COUNT) {
      throw new ExifError(
        "E_BAD_COUNT",
        `标签 0x${tag.toString(16).padStart(4, "0")} 数量 ${fieldCount} 超过上限 ${MAX_FIELD_COUNT}`,
        segName,
        entryOffset + 4
      );
    }
    const totalBytes = fieldCount * TYPE_SIZES[type];
    const inline = totalBytes <= 4;
    let valueOffset: number;
    if (inline) {
      valueOffset = entryOffset + 8;
    } else {
      const rel = r.u32(entryOffset + 8);
      valueOffset = tiffStart + rel;
      if (valueOffset < tiffStart || valueOffset + totalBytes > seg.dataEnd) {
        throw new ExifError(
          "E_BAD_OFFSET",
          `标签 0x${tag.toString(16).padStart(4, "0")} 值偏移 ${rel}（相对 TIFF 起点）+ ` +
            `${totalBytes} 字节越出 APP1 段（TIFF 起点 ${tiffStart}，段结束 ${seg.dataEnd}）`,
          segName,
          entryOffset + 8
        );
      }
    }
    const value = readValues(r, type, fieldCount, valueOffset, diagnostics);
    tags.push({
      tag,
      ifd: ifdName,
      type,
      typeName,
      count: fieldCount,
      inline,
      entryOffset,
      valueOffset,
      valueLength: totalBytes,
      value,
      diagnostics,
    });
  }
}

/**
 * 解析一个 Exif APP1 段：TIFF 头、IFD0、以及 IFD0 中 ExifIFD 指针（0x8769）
 * 指向的一个子目录。不展开 GPS、MakerNote、缩略图。
 */
export function parseExifSegment(buf: Buffer, seg: Segment): ParsedExif {
  const segName = "APP1(Exif)";
  const tiffStart = seg.dataStart + 6; // 跳过 "Exif\0\0"
  if (tiffStart + 8 > seg.dataEnd) {
    throw new ExifError(
      "E_TRUNCATED",
      `TIFF 头需要 8 字节，但段内剩余不足（TIFF 起点 ${tiffStart}，段结束 ${seg.dataEnd}）`,
      segName,
      tiffStart
    );
  }
  const byteOrder = buf.readUInt16BE(tiffStart);
  let little: boolean;
  let endian: "LE" | "BE";
  if (byteOrder === 0x4949) {
    little = true;
    endian = "LE";
  } else if (byteOrder === 0x4d4d) {
    little = false;
    endian = "BE";
  } else {
    throw new ExifError(
      "E_BAD_ENDIAN",
      `非法 TIFF 字节序标识 0x${byteOrder.toString(16).padStart(4, "0")}（期望 II=0x4949 或 MM=0x4D4D）`,
      segName,
      tiffStart
    );
  }
  const r = new Reader(buf, little);
  const magic = r.u16(tiffStart + 2);
  if (magic !== 42) {
    throw new ExifError("E_BAD_TIFF", `非法 TIFF 魔数 ${magic}（期望 42）`, segName, tiffStart + 2);
  }
  const ifd0Rel = r.u32(tiffStart + 4);
  if (ifd0Rel < 8) {
    throw new ExifError(
      "E_BAD_OFFSET",
      `IFD0 偏移 ${ifd0Rel} 非法（必须 >= 8，指向 TIFF 头之后）`,
      segName,
      tiffStart + 4
    );
  }
  const tags: RawTag[] = [];
  const visited = new Set<number>();
  const visitedList: number[] = [];

  const visit = (relOffset: number, name: string) => {
    if (visited.has(relOffset)) {
      throw new ExifError(
        "E_CYCLE",
        `检测到 IFD 指针循环：偏移 ${relOffset}（相对 TIFF 起点）被重复访问`,
        segName,
        tiffStart + relOffset
      );
    }
    if (visited.size >= MAX_IFDS) {
      throw new ExifError("E_LIMIT", `IFD 数量超过上限 ${MAX_IFDS}`, segName, tiffStart + relOffset);
    }
    visited.add(relOffset);
    visitedList.push(relOffset);
    parseIfd(r, tiffStart + relOffset, name, seg, tiffStart, tags);
  };

  visit(ifd0Rel, "IFD0");

  // 在 IFD0 中查找 ExifIFD 指针（0x8769），只跟随一个子目录
  const exifPtr = tags.find((t) => t.ifd === "IFD0" && t.tag === 0x8769);
  if (exifPtr) {
    if (exifPtr.type !== 4 || exifPtr.count !== 1 || !Array.isArray(exifPtr.value)) {
      throw new ExifError(
        "E_BAD_TIFF",
        "ExifIFD 指针（0x8769）必须是类型 LONG、数量 1",
        segName,
        exifPtr.entryOffset
      );
    }
    const subRel = (exifPtr.value as number[])[0];
    if (subRel < 8) {
      throw new ExifError(
        "E_BAD_OFFSET",
        `ExifIFD 指针 ${subRel} 非法（必须 >= 8）`,
        segName,
        exifPtr.valueOffset
      );
    }
    visit(subRel, "ExifIFD");
  }

  return { endian, tiffStart, tags, visitedIfds: visitedList };
}
