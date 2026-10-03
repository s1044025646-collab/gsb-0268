# JPEG EXIF 标签解析与偏移诊断后端

一个 Windows 本地可运行的 JPEG 照片元数据检查服务。只读文件并解释 EXIF：
**不解码像素、不旋转图片、不修改标签、不访问网络照片**。仅提供 HTTP API 与 CLI，无前端。

技术栈：TypeScript + Node.js（>= 22.5）+ SQLite（`node:sqlite` 内置模块，无原生依赖）。
不依赖 Docker、WSL、付费服务或外部在线 API。

## 快速开始

```powershell
npm install
npm run build     # 编译 TypeScript 到 dist/
npm test          # 构建并运行全部测试
npm run demo      # 生成合成演示文件并走一遍 CLI 流程
npm start         # 启动 HTTP 服务（默认自动选择空闲端口）
```

CLI 直接使用：`node dist/src/cli.js <命令>`，例如：

```powershell
node dist/src/cli.js import path\to\photo.jpg
node dist/src/cli.js list
node dist/src/cli.js segments 1
node dist/src/cli.js tags 1
node dist/src/cli.js offsets 1
node dist/src/cli.js report 1
node dist/src/cli.js export 1 report.json
node dist/src/cli.js serve --port 8080   # 不传 --port 则自动选空闲端口
```

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查与解析器版本 |
| POST | `/files/import` | 导入文件，Body：`{"path": "..."}` |
| GET | `/files` | 已导入文件列表 |
| GET | `/files/:id` | 文件记录 |
| GET | `/files/:id/segments` | JPEG 段清单 |
| GET | `/files/:id/tags` | 全部标签 |
| GET | `/files/:id/tags/:tag` | 单个标签（十进制编号，如 Orientation 为 274） |
| GET | `/files/:id/offsets` | 逐条偏移解释 |
| GET | `/files/:id/report` | 解析报告 |
| GET | `/files/:id/report?format=json` | 导出 JSON（带下载头） |

错误统一返回 `{"error": {"code", "message", "segment", "offset"}}`，HTTP 状态：
400 参数校验失败、404 记录不存在、422 解析类错误。

## 支持的子集（明确边界）

- JPEG 标记扫描：识别 SOI/APPn/SOS/EOI 等，找到以 `Exif\0\0` 开头的 APP1；
  非 EXIF 的 APP1（如 XMP）跳过；扫描到 SOS 即停止，不会把压缩像素里的 `0xFF` 字节误认为标记。
- TIFF 解析：两种字节序（II/MM）、魔数 42、IFD0 以及 IFD0 中 ExifIFD 指针（0x8769）
  指向的**一个**子目录。所有偏移均相对 TIFF 起点解引用，绝不按 JPEG 文件起点。
- 字段类型：BYTE、ASCII、SHORT、LONG、RATIONAL 五类。值 ≤ 4 字节取条目内联值，
  否则按偏移读取；读取前校验「类型长度 × 数量」、条目范围与外部值范围。
  数量是**值个数**而非字节数。
- 解释的标签：Orientation、Make、Model、DateTime、DateTimeOriginal、
  PixelXDimension、PixelYDimension、ExposureTime。
  未知标签按支持的类型展示原始值；未知类型明确标注并跳过值读取。
- **不展开** GPS、MakerNote、缩略图 IFD；不支持完整 TIFF 与全部 EXIF 标签。

## 解释边界

- **Orientation**：仅接受 1–8，显示其变换含义（如「顺时针旋转 90° 显示」），
  但**不对图片做任何变换**；超出 1–8 给出诊断。
- **日期**：DateTime / DateTimeOriginal 是本地墙钟时间文本，不含时区；
  保留原始文本，**不擅自当作 UTC** 或做任何时区换算。
- **ExposureTime**：保留原始分子/分母（如 `1/125`），显示值为约等快门速度；
  分母为零时给出「分母为零」诊断而不是崩溃。

## 安全与限制

- 目录数量上限 8、每个 IFD 条目上限 512、单字段数量上限 1,000,000；
  非法大数量、截断、越界在读取前即报错，不会触发无界分配。
- 检测 IFD 指针循环（重复访问同一偏移报 `E_CYCLE`）。
- 没有 EXIF 的正常 JPEG 返回 `no_metadata` 状态，不会误报为文件损坏。
- 解析失败的文件保存为 `error` 状态报告，永远不会产生 `ok` 报告。

## 存储

- 数据目录默认为项目内 `data/`（可用环境变量 `EXIF_DATA_DIR` 覆盖），
  只写该目录：SQLite 库 `data/exif.db`、只读副本 `data/files/<sha256>.jpg`。
- 保存内容：文件 SHA-256 摘要、只读副本位置、解析器版本、状态与完整报告 JSON。
- 同一文件（相同 SHA-256）重复导入：返回既有记录并标记 `duplicate=true`，不重复解析。
- 服务重启后既有记录可正常查询。

## 错误码

`E_VALIDATION` 参数错误 · `E_IO` 文件读取失败 · `E_NOT_FOUND` 记录不存在 ·
`E_NOT_JPEG` 非 JPEG · `E_NO_EXIF` 无 EXIF（状态码，非损坏） ·
`E_TRUNCATED` 截断 · `E_BAD_TIFF` TIFF 头非法 · `E_BAD_ENDIAN` 字节序标识非法 ·
`E_BAD_OFFSET` 偏移越界 · `E_BAD_COUNT` 数量非法 · `E_UNKNOWN_TYPE` 未知类型 ·
`E_CYCLE` 指针循环 · `E_LIMIT` 超出上限

## 测试

测试夹具（`test/fixtures.ts`）按字节手工构造 JPEG，布局固定、关键偏移预先写定，
不使用被测解析器自我验证。覆盖：两种字节序语义一致、内联 SHORT、外置 ASCII、
有理数、非 EXIF APP1、无 EXIF、缺少 TIFF 头、错误长度、偏移越界、坏指针（循环）、
零分母、未知类型、非法大数量、SOS 后停止扫描、导入幂等与重启持久化。

## 已知限制

- `node:sqlite` 在 Node 25 仍打印 ExperimentalWarning，属正常提示。
- ASCII 值按 latin1 逐字节读取，不做编码猜测。
- 仅解析第一个 Exif APP1 段。
