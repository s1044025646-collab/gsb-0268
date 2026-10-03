import type { RawTag, Rational } from "./tiff";

export interface InterpretedTag extends RawTag {
  name: string;
  known: boolean;
  /** 面向展示的值（曝光时间含显示值等） */
  display: string | null;
  /** 语义解释（不执行任何图片变换） */
  interpretation: string | null;
}

const TAG_NAMES: Record<number, string> = {
  0x010f: "Make",
  0x0110: "Model",
  0x0112: "Orientation",
  0x0132: "DateTime",
  0x8769: "ExifIFDPointer",
  0x9003: "DateTimeOriginal",
  0x829a: "ExposureTime",
  0xa002: "PixelXDimension",
  0xa003: "PixelYDimension",
};

const ORIENTATION_MEANINGS: Record<number, string> = {
  1: "正常（不旋转、不镜像）",
  2: "水平镜像",
  3: "旋转 180°",
  4: "垂直镜像",
  5: "水平镜像后旋转 270°（顺时针 90° 的转置）",
  6: "顺时针旋转 90° 显示",
  7: "水平镜像后顺时针旋转 90°",
  8: "逆时针旋转 90° 显示",
};

function rationalDisplay(r: Rational): string {
  if (r.den === 0) return `${r.num}/0（分母为零，无效）`;
  const v = r.num / r.den;
  if (v >= 1) return `${r.num}/${r.den}（${v} 秒）`;
  // 常见快门速度显示为 1/x
  const inv = r.den / r.num;
  const invRounded = Number.isInteger(inv) ? inv : Math.round(inv);
  return `${r.num}/${r.den}（约 1/${invRounded} 秒）`;
}

export function interpretTag(raw: RawTag): InterpretedTag {
  const name = TAG_NAMES[raw.tag] ?? `Unknown(0x${raw.tag.toString(16).padStart(4, "0")})`;
  const known = raw.tag in TAG_NAMES && raw.tag !== 0x8769;
  let display: string | null = null;
  let interpretation: string | null = null;
  const diagnostics = [...raw.diagnostics];

  const nums = Array.isArray(raw.value) ? (raw.value as number[]) : null;

  switch (raw.tag) {
    case 0x010f:
    case 0x0110:
    case 0x0132:
    case 0x9003: {
      if (typeof raw.value === "string") {
        const text = raw.value.replace(/\0+$/, "");
        display = text;
        if (raw.tag === 0x0132 || raw.tag === 0x9003) {
          interpretation =
            "EXIF 日期为本地墙钟时间文本（YYYY:MM:DD HH:MM:SS），不含时区；此处保留原文，不按 UTC 解释";
        }
      }
      break;
    }
    case 0x0112: {
      if (nums && nums.length >= 1) {
        const v = nums[0];
        display = String(v);
        if (v >= 1 && v <= 8) {
          interpretation = `${ORIENTATION_MEANINGS[v]}（仅说明含义，不对图片做变换）`;
        } else {
          diagnostics.push(`Orientation 值 ${v} 超出合法范围 1-8`);
          interpretation = "非法方向值";
        }
      }
      break;
    }
    case 0x829a: {
      const rats = Array.isArray(raw.value) ? (raw.value as Rational[]) : null;
      if (rats && rats.length >= 1 && typeof rats[0] === "object") {
        display = rationalDisplay(rats[0]);
        interpretation = "曝光时间，保留原始分子/分母";
      }
      break;
    }
    case 0xa002:
    case 0xa003: {
      if (nums && nums.length >= 1) {
        display = String(nums[0]);
        interpretation = raw.tag === 0xa002 ? "有效像素宽度" : "有效像素高度";
      }
      break;
    }
    case 0x8769: {
      if (nums && nums.length >= 1) {
        display = String(nums[0]);
        interpretation = "ExifIFD 子目录偏移（相对 TIFF 起点）";
      }
      break;
    }
    default: {
      if (typeof raw.value === "string") {
        display = JSON.stringify(raw.value.replace(/\0+$/, ""));
      } else if (Array.isArray(raw.value)) {
        display = raw.value
          .slice(0, 8)
          .map((v) => (typeof v === "object" ? `${(v as Rational).num}/${(v as Rational).den}` : String(v)))
          .join(raw.value.length > 8 ? ", …" : "");
      }
      break;
    }
  }

  return { ...raw, name, known, display, interpretation, diagnostics };
}
