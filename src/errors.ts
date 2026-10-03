export type ErrorCode =
  | "E_VALIDATION"
  | "E_IO"
  | "E_NOT_FOUND"
  | "E_NOT_JPEG"
  | "E_NO_EXIF"
  | "E_TRUNCATED"
  | "E_BAD_TIFF"
  | "E_BAD_ENDIAN"
  | "E_BAD_OFFSET"
  | "E_BAD_COUNT"
  | "E_UNKNOWN_TYPE"
  | "E_CYCLE"
  | "E_LIMIT";

export class ExifError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public segment?: string,
    public offset?: number
  ) {
    super(message);
    this.name = "ExifError";
  }
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      segment: this.segment ?? null,
      offset: this.offset ?? null,
    };
  }
}
