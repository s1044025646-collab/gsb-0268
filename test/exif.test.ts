import { test } from "node:test";
import assert from "node:assert/strict";
import { scanSegments, parseFile, parseExifSegment } from "../src/exif";
import { interpretTag } from "../src/interpret";
import { buildFixture } from "../src/fixtures";

// Pre-written absolute offsets for the deterministic fixture layout
const OFF = {
  app0: 2, app1Xmp: 22, app1Exif: 34, tiffStart: 44,
  ifd0: 52, ifd0Entries: 54,
  makeEntry: 54, modelEntry: 66, orientationEntry: 78, dateTimeEntry: 90, exifPtrEntry: 102,
  orientationInlineValue: 86,
  exifIfd: 118, exifIfdEntries: 120,
  exposureEntry: 120, pixelXEntry: 144,
  pixelXInlineValue: 152,
  makeValue: 172, modelValue: 180, dateTimeValue: 188,
  exposureValue: 208, dateTimeOriginalValue: 216,
  sos: 236,
};

test("段扫描：非 EXIF APP1 被跳过，SOS 处停止", () => {
  const { buf } = buildFixture();
  const segs = scanSegments(buf);
  assert.equal(segs.length, 4); // APP0, APP1(XMP), APP1(Exif), SOS
  assert.equal(segs[0].name, "APP0");
  assert.equal(segs[0].offset, OFF.app0);
  assert.equal(segs[1].name, "APP1");
  assert.equal(segs[1].offset, OFF.app1Xmp);
  assert.equal(segs[1].isExif, false); // 非 EXIF 的 APP1
  assert.equal(segs[2].isExif, true);
  assert.equal(segs[2].offset, OFF.app1Exif);
  assert.equal(segs[3].name, "SOS");
  assert.equal(segs[3].offset, OFF.sos);
  // SOS 之后扫描数据里的 0xFF 0xE1 不得被当成段
  assert.ok(!segs.some((s) => s.offset > OFF.sos));
});

test("小端（II）完整解析：内联 SHORT、外置 ASCII、有理数", () => {
  const { buf } = buildFixture({ byteOrder: "II" });
  const r = parseFile(buf);
  assert.equal(r.status, "ok");
  assert.equal(r.byteOrder, "II");
  assert.equal(r.exif!.tiffStart, OFF.tiffStart);
  const byTag = new Map(r.exif!.tags.map((t) => [t.tag, t]));

  const make = byTag.get(0x010f)!;
  assert.equal(make.typeName, "ASCII");
  assert.equal(make.count, 8);
  assert.equal(make.inline, false);
  assert.equal(make.valueOffset, OFF.makeValue);
  assert.equal(make.valueLength, 8);
  assert.equal(make.raw, "TestCam\0");

  const model = byTag.get(0x0110)!;
  assert.equal(model.valueOffset, OFF.modelValue);
  assert.equal(model.raw, "Model X\0");

  const ori = byTag.get(0x0112)!;
  assert.equal(ori.typeName, "SHORT");
  assert.equal(ori.inline, true);
  assert.equal(ori.valueOffset, OFF.orientationInlineValue);
  assert.deepEqual(ori.raw, [6]);

  const dt = byTag.get(0x0132)!;
  assert.equal(dt.valueOffset, OFF.dateTimeValue);
  assert.equal(dt.raw, "2024:01:02 03:04:05\0");

  const ptr = byTag.get(0x8769)!;
  assert.deepEqual(ptr.raw, [74]); // TIFF 相对偏移

  const exp = byTag.get(0x829a)!;
  assert.equal(exp.typeName, "RATIONAL");
  assert.equal(exp.valueOffset, OFF.exposureValue);
  assert.deepEqual(exp.raw, [{ numerator: 1, denominator: 125 }]);

  const dto = byTag.get(0x9003)!;
  assert.equal(dto.valueOffset, OFF.dateTimeOriginalValue);

  const px = byTag.get(0xa002)!;
  assert.equal(px.inline, true);
  assert.equal(px.valueOffset, OFF.pixelXInlineValue);
  assert.deepEqual(px.raw, [4000]);

  assert.equal(r.exif!.ifds[0].offset, OFF.ifd0);
  assert.equal(r.exif!.ifds[1].offset, OFF.exifIfd);
});

test("大端（MM）与小端语义一致", () => {
  const ii = parseFile(buildFixture({ byteOrder: "II" }).buf);
  const mm = parseFile(buildFixture({ byteOrder: "MM" }).buf);
  assert.equal(mm.byteOrder, "MM");
  const pick = (r: typeof ii) => new Map(r.exif!.tags.map((t) => [t.tag, JSON.stringify(t.raw)]));
  const a = pick(ii), b = pick(mm);
  for (const [tag, raw] of a) {
    if (tag === 0x8769) continue;
    assert.equal(b.get(tag), raw, `tag 0x${tag.toString(16)} 两种字节序语义应一致`);
  }
  // 字节区间也一致（布局相同）
  const off = (r: typeof ii) => r.exif!.tags.map((t) => [t.tag, t.valueOffset, t.valueLength].join(":"));
  assert.deepEqual(off(mm), off(ii));
});

test("解释层：Orientation / 曝光时间 / 日期边界", () => {
  const r = parseFile(buildFixture({}).buf);
  const byTag = new Map(r.exif!.tags.map((t) => [t.tag, t]));
  const ori = interpretTag(byTag.get(0x0112)!);
  assert.match(ori.display, /6/);
  assert.match(ori.display, /顺时针/);
  const exp = interpretTag(byTag.get(0x829a)!);
  assert.match(exp.display, /1\/125/);
  const dt = interpretTag(byTag.get(0x0132)!);
  assert.equal(dt.display, "2024:01:02 03:04:05");
  assert.match(dt.note!, /未做时区假设/);
});

test("Orientation 超出 1-8 给出诊断", () => {
  const r = parseFile(buildFixture({ orientation: 9 }).buf);
  const ori = interpretTag(r.exif!.tags.find((t) => t.tag === 0x0112)!);
  assert.match(ori.error!, /ORIENTATION_INVALID/);
});

test("零分母曝光时间有明确诊断", () => {
  const r = parseFile(buildFixture({ exposureDen: 0 }).buf);
  assert.equal(r.status, "ok"); // 解析本身成功
  const exp = interpretTag(r.exif!.tags.find((t) => t.tag === 0x829a)!);
  assert.match(exp.error!, /ZERO_DENOMINATOR/);
  assert.match(exp.display, /1\/0/);
});

test("无 EXIF 的正常 JPEG 返回 no_exif 而非损坏", () => {
  const r = parseFile(buildFixture({ skipExif: true }).buf);
  assert.equal(r.status, "no_exif");
  assert.equal(r.errors.length, 0);
});

test("缺少必需 TIFF 头（坏魔数）定位到段与偏移", () => {
  const r = parseFile(buildFixture({ badMagic: true }).buf);
  assert.equal(r.status, "error");
  assert.equal(r.errors[0].code, "BAD_TIFF_HEADER");
  assert.equal(r.errors[0].segmentOffset, OFF.app1Exif);
  assert.equal(r.errors[0].fileOffset, OFF.tiffStart + 2);
});

test("非法字节序标记", () => {
  const r = parseFile(buildFixture({ badByteOrder: true }).buf);
  assert.equal(r.status, "error");
  assert.equal(r.errors[0].code, "BAD_BYTE_ORDER");
  assert.equal(r.errors[0].fileOffset, OFF.tiffStart);
});

test("错误长度：段数据被截断", () => {
  const r = parseFile(buildFixture({ truncateAt: 100 }).buf);
  assert.equal(r.status, "error");
  assert.equal(r.errors[0].code, "TRUNCATED");
  assert.equal(r.errors[0].fileOffset, OFF.app1Exif);
});

test("偏移越界：外置值指针超出文件", () => {
  const r = parseFile(buildFixture({ makeOffsetOverride: 0x00ffffff }).buf);
  const make = r.exif!.tags.find((t) => t.tag === 0x010f)!;
  assert.equal(make.error!.code, "VALUE_OUT_OF_RANGE");
  assert.equal(make.error!.fileOffset, OFF.tiffStart + 0x00ffffff);
});

test("坏指针：ExifIFD 指针循环被拒绝", () => {
  const r = parseFile(buildFixture({ exifPtrTarget: 8 }).buf); // 指回 IFD0
  assert.equal(r.status, "error");
  assert.ok(r.errors.some((e) => e.code === "POINTER_CYCLE"));
});

test("非法大数量不引发无界分配", () => {
  const r = parseFile(buildFixture({ makeCountOverride: 0xffffffff }).buf);
  const make = r.exif!.tags.find((t) => t.tag === 0x010f)!;
  assert.equal(make.error!.code, "COUNT_TOO_LARGE");
});

test("未知字段类型明确标注", () => {
  const r = parseFile(buildFixture({ makeTypeOverride: 13 }).buf);
  const make = r.exif!.tags.find((t) => t.tag === 0x010f)!;
  assert.equal(make.error!.code, "UNKNOWN_TYPE");
  assert.match(make.typeName, /UNKNOWN/);
});

test("非 JPEG 输入", () => {
  const r = parseFile(Buffer.from("not a jpeg at all"));
  assert.equal(r.status, "error");
  assert.equal(r.errors[0].code, "NOT_JPEG");
});
