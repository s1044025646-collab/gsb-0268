import { createHash } from "node:crypto";
import { scanSegments, type Segment } from "./jpeg";
import { parseExifSegment } from "./tiff";
import { interpretTag, type InterpretedTag } from "./tags";
import { ExifError } from "./errors";
import { PARSER_VERSION } from "./version";

export type ReportStatus = "ok" | "no_metadata" | "error";

export interface Report {
  parserVersion: string;
  fileName: string | null;
  sha256: string;
  fileSize: number;
  status: ReportStatus;
  endian: "LE" | "BE" | null;
  tiffStart: number | null;
  segments: Segment[];
  tags: InterpretedTag[];
  errors: ReturnType<ExifError["toJSON"]>[];
}

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** 解析 JPEG 缓冲区并生成完整报告；不修改输入。 */
export function analyzeBuffer(buf: Buffer, fileName: string | null = null): Report {
  const base: Report = {
    parserVersion: PARSER_VERSION,
    fileName,
    sha256: sha256(buf),
    fileSize: buf.length,
    status: "ok",
    endian: null,
    tiffStart: null,
    segments: [],
    tags: [],
    errors: [],
  };
  try {
    base.segments = scanSegments(buf);
  } catch (e) {
    if (e instanceof ExifError) {
      base.status = "error";
      base.errors.push(e.toJSON());
      return base;
    }
    throw e;
  }
  const exifSeg = base.segments.find((s) => s.isExif);
  if (!exifSeg) {
    // 正常 JPEG 但没有 EXIF：明确的无元数据状态，不是文件损坏
    base.status = "no_metadata";
    return base;
  }
  try {
    const parsed = parseExifSegment(buf, exifSeg);
    base.endian = parsed.endian;
    base.tiffStart = parsed.tiffStart;
    base.tags = parsed.tags.map(interpretTag);
    base.status = "ok";
  } catch (e) {
    if (e instanceof ExifError) {
      base.status = "error";
      base.errors.push(e.toJSON());
      return base;
    }
    throw e;
  }
  return base;
}

/** 逐条偏移解释 */
export function explainTagOffset(t: InterpretedTag, tiffStart: number | null): string {
  const lines: string[] = [];
  lines.push(
    `标签 ${t.name}（0x${t.tag.toString(16).padStart(4, "0")}），所在目录 ${t.ifd}，条目位于文件偏移 ${t.entryOffset}（12 字节）`
  );
  lines.push(
    `类型 ${t.typeName ?? `未知(${t.type})`}，数量 ${t.count}，值共 ${t.valueLength} 字节`
  );
  if (t.typeName === null) {
    lines.push("未知类型：未读取值");
    return lines.join("\n");
  }
  if (t.inline) {
    lines.push(
      `值不超过 4 字节，内联存储于条目内偏移 ${t.valueOffset}..${t.valueOffset + t.valueLength - 1}`
    );
  } else {
    lines.push(
      `值超过 4 字节，条目内存放相对 TIFF 起点的偏移 ${
        tiffStart !== null ? t.valueOffset - tiffStart : "?"
      }，实际值位于文件偏移 ${t.valueOffset}..${t.valueOffset + t.valueLength - 1}`
    );
  }
  if (t.diagnostics.length > 0) {
    lines.push(`诊断：${t.diagnostics.join("；")}`);
  }
  return lines.join("\n");
}
