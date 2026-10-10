import sharp from "npm:sharp@0.34.5";

export class MediaInputError extends Error {}
export const MAX_BODY = 5 * 1024 * 1024;
export const MAX_PIXELS = 16_777_216;
export type ImageVariants = {
  medium: Uint8Array;
  thumb: Uint8Array;
  etag: string;
};

export async function normalize(
  bytes: Uint8Array,
  contentType: string,
): Promise<ImageVariants> {
  if (!bytes.length || bytes.length > MAX_BODY) {
    throw new MediaInputError("Image size exceeds bounds");
  }
  const format = new Map([["image/png", "png"], ["image/jpeg", "jpeg"], [
    "image/jpg",
    "jpeg",
  ], ["image/gif", "gif"]]).get(contentType.split(";")[0].trim().toLowerCase());
  if (!format) throw new MediaInputError("Unsupported image format");
  let pixels: Uint8Array, width: number, height: number;
  try {
    const source = sharp(bytes, {
      limitInputPixels: MAX_PIXELS,
      pages: 1,
      failOn: "warning",
    });
    const metadata = await source.metadata();
    if (metadata.format !== format) {
      throw new MediaInputError("Image format does not match content type");
    }
    const decoded = await source.rotate().toColourspace("srgb").ensureAlpha()
      .raw().toBuffer({ resolveWithObject: true });
    if (decoded.info.channels !== 4) {
      throw new Error("Image decoder did not produce RGBA");
    }
    pixels = decoded.data;
    width = decoded.info.width;
    height = decoded.info.height;
  } catch (error) {
    if (error instanceof MediaInputError) throw error;
    if (
      error instanceof Error &&
      // libvips' load failures, which only the client's bytes cause; any
      // other failure is ours and propagates.
      /VipsForeignLoad|VipsJpeg|pngload|jpegload|gifload|Input buffer|pixel limit|premature end|corrupt/i
        .test(error.message)
    ) {
      throw new MediaInputError("Image cannot be decoded");
    }
    throw error;
  }
  // Each edge scans inward and stops at its first opaque pixel, so an opaque
  // image costs a few rows rather than every pixel on the event loop.
  const opaque = (x: number, y: number) => pixels[(y * width + x) * 4 + 3] !== 0;
  const rowOpaque = (y: number) => { for (let x = 0; x < width; x++) if (opaque(x, y)) return true; return false; };
  let top = 0;
  while (top < height && !rowOpaque(top)) top++;
  if (top === height) throw new MediaInputError("Image is entirely transparent");
  let bottom = height - 1;
  while (!rowOpaque(bottom)) bottom--;
  const columnOpaque = (x: number) => { for (let y = top; y <= bottom; y++) if (opaque(x, y)) return true; return false; };
  let left = 0;
  while (!columnOpaque(left)) left++;
  let right = width - 1;
  while (!columnOpaque(right)) right--;
  const cropped = sharp(pixels, { raw: { width, height, channels: 4 } })
    .extract({ left, top, width: right - left + 1, height: bottom - top + 1 });
  const [medium, thumb] = await Promise.all(
    [100, 15].map((side) =>
      cropped.clone().resize(side, side, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      }).png({ compressionLevel: 9 }).toBuffer()
    ),
  );
  if (medium.length > 65_536 || thumb.length > 4096) {
    throw new Error("Normalized image exceeds storage bounds");
  }
  const combined = new Uint8Array(medium.length + thumb.length);
  combined.set(medium);
  combined.set(thumb, medium.length);
  const etag = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", combined)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  return { medium, thumb, etag };
}
