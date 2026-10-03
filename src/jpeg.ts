import { ExifError } from "./errors";

export interface Segment {
  index: number;
  marker: number;
  name: string;
  /** 标记码在文件中的偏移（0xFF 前缀所在位置） */
  offset: number;
  /** 段数据起始（长度字段之后；无长度标记则等于 offset+2） */
  dataStart: number;
  /** 段数据结束（不含） */
  dataEnd: number;
  /** 段数据长度（不含标记与长度字段） */
  dataLength: number;
  /** 是否为以 "Exif\0\0" 开头的 APP1 */
  isExif: boolean;
}

const MARKER_NAMES: Record<number, string> = {
  0xd8: "SOI",
  0xd9: "EOI",
  0xda: "SOS",
  0xc0: "SOF0",
  0xc1: "SOF1",
  0xc2: "SOF2",
  0xc4: "DHT",
  0xdb: "DQT",
  0xdd: "DRI",
  0xfe: "COM",
};

export function markerName(marker: number): string {
  if (MARKER_NAMES[marker]) return MARKER_NAMES[marker];
  if (marker >= 0xe0 && marker <= 0xef) return `APP${marker - 0xe0}`;
  if (marker >= 0xd0 && marker <= 0xd7) return `RST${marker - 0xd0}`;
  return `0xFF${marker.toString(16).toUpperCase().padStart(2, "0")}`;
}

/** 无长度字段的独立标记 */
function isStandalone(marker: number): boolean {
  return (
    marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9) // RST0-7, SOI, EOI
  );
}

const EXIF_HEADER = Buffer.from([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]); // "Exif\0\0"

/**
 * 顺序扫描 JPEG 标记。遇到 SOS（扫描数据开始）或 EOI 即停止，
 * 不进入压缩像素数据，避免把像素字节误认为标记。
 */
export function scanSegments(buf: Buffer): Segment[] {
  if (buf.length < 2 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    throw new ExifError("E_NOT_JPEG", "文件不是 JPEG（缺少 SOI 标记）", undefined, 0);
  }
  const segments: Segment[] = [];
  let pos = 2;
  let index = 0;
  while (pos + 1 < buf.length) {
    // 标记前可能有 0xFF 填充字节
    if (buf[pos] !== 0xff) {
      throw new ExifError(
        "E_NOT_JPEG",
        `期望标记前缀 0xFF，实际为 0x${buf[pos].toString(16).padStart(2, "0")}`,
        undefined,
        pos
      );
    }
    const markerOffset = pos;
    while (pos < buf.length && buf[pos] === 0xff) pos++;
    if (pos >= buf.length) break;
    const marker = buf[pos];
    pos++;
    if (marker === 0x00) continue; // 0xFF00 是填充，不是标记
    const name = markerName(marker);
    if (marker === 0xda) {
      // SOS：记录段头后停止，扫描数据不解析
      if (pos + 2 > buf.length) {
        throw new ExifError("E_TRUNCATED", "SOS 段长度字段被截断", name, markerOffset);
      }
      const len = buf.readUInt16BE(pos);
      segments.push({
        index: index++,
        marker,
        name,
        offset: markerOffset,
        dataStart: pos + 2,
        dataEnd: Math.min(pos + len, buf.length),
        dataLength: len - 2,
        isExif: false,
      });
      break;
    }
    if (marker === 0xd9) break; // EOI
    if (isStandalone(marker)) continue;
    if (pos + 2 > buf.length) {
      throw new ExifError("E_TRUNCATED", `${name} 段长度字段被截断`, name, markerOffset);
    }
    const len = buf.readUInt16BE(pos);
    if (len < 2) {
      throw new ExifError("E_BAD_TIFF", `${name} 段长度非法（${len}）`, name, markerOffset);
    }
    const dataStart = pos + 2;
    const dataEnd = pos + len;
    if (dataEnd > buf.length) {
      throw new ExifError(
        "E_TRUNCATED",
        `${name} 段声明长度 ${len} 超出文件剩余 ${buf.length - pos} 字节`,
        name,
        markerOffset
      );
    }
    const isExif =
      marker === 0xe1 &&
      len - 2 >= 6 &&
      buf.subarray(dataStart, dataStart + 6).equals(EXIF_HEADER);
    segments.push({
      index: index++,
      marker,
      name,
      offset: markerOffset,
      dataStart,
      dataEnd,
      dataLength: len - 2,
      isExif,
    });
    pos = dataEnd;
  }
  return segments;
}
