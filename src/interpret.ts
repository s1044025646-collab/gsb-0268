// Tag interpretation layer: explains well-known tags without transforming anything.
import { TagEntry } from "./exif";

export const TAG_NAMES: Record<number, string> = {
  0x010f: "Make",
  0x0110: "Model",
  0x0112: "Orientation",
  0x0132: "DateTime",
  0x829a: "ExposureTime",
  0x8769: "ExifIFDPointer",
  0x9003: "DateTimeOriginal",
  0xa002: "PixelXDimension",
  0xa003: "PixelYDimension",
};

export const ORIENTATION_MEANINGS: Record<number, string> = {
  1: "正常（不旋转）",
  2: "水平翻转",
  3: "旋转 180°",
  4: "垂直翻转",
  5: "转置（沿左上-右下对角线翻转）",
  6: "顺时针旋转 90° 显示",
  7: "转置后对角翻转",
  8: "逆时针旋转 90° 显示",
};

export interface InterpretedTag {
  name: string;
  known: boolean;
  display: string;
  note?: string;
  error?: string;
}

function asciiOf(entry: TagEntry): string {
  return typeof entry.raw === "string" ? entry.raw.replace(/\0+$/, "") : String(entry.raw);
}

export function interpretTag(entry: TagEntry): InterpretedTag {
  const name = TAG_NAMES[entry.tag];
  const known = name !== undefined;
  const label = name ?? `Unknown(${entry.tagHex})`;
  if (entry.error) {
    return { name: label, known, display: "", error: `${entry.error.code}: ${entry.error.message}` };
  }
  switch (entry.tag) {
    case 0x010f:
    case 0x0110:
      return { name: label, known, display: asciiOf(entry) };
    case 0x0132:
    case 0x9003:
      // 保留原始文本，不当作 UTC 解析
      return { name: label, known, display: asciiOf(entry), note: "原始文本，未做时区假设" };
    case 0x0112: {
      const v = (entry.raw as number[])[0];
      if (v >= 1 && v <= 8) {
        return { name: label, known, display: `${v}（${ORIENTATION_MEANINGS[v]}）`, note: "仅说明含义，不实际变换图片" };
      }
      return { name: label, known, display: String(v), error: `ORIENTATION_INVALID: Orientation 应为 1-8，实际 ${v}` };
    }
    case 0xa002:
    case 0xa003: {
      const v = (entry.raw as number[])[0];
      return { name: label, known, display: `${v} px` };
    }
    case 0x829a: {
      const r = (entry.raw as { numerator: number; denominator: number }[])[0];
      if (r.denominator === 0) {
        return { name: label, known, display: `${r.numerator}/0`, error: "ZERO_DENOMINATOR: 曝光时间分母为零" };
      }
      const sec = r.numerator / r.denominator;
      const disp = sec < 1 && r.numerator > 0
        ? `1/${Math.round(r.denominator / r.numerator)} s（${r.numerator}/${r.denominator}）`
        : `${sec} s（${r.numerator}/${r.denominator}）`;
      return { name: label, known, display: disp };
    }
    case 0x8769:
      return { name: label, known, display: `-> ExifIFD @ TIFF+${(entry.raw as number[])[0]}` };
    default: {
      if (entry.typeName.startsWith("UNKNOWN")) {
        return { name: label, known: false, display: "", note: "未知类型，无法解码" };
      }
      let display: string;
      if (typeof entry.raw === "string") display = asciiOf(entry);
      else if (typeof entry.raw[0] === "object") {
        display = (entry.raw as { numerator: number; denominator: number }[])
          .map((r) => `${r.numerator}/${r.denominator}`).join(", ");
      } else {
        display = (entry.raw as number[]).join(", ");
      }
      return { name: label, known: false, display };
    }
  }
}
