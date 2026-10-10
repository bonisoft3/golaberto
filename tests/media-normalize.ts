import sharp from "npm:sharp@0.34.5";
import { MAX_BODY, MediaInputError, normalize } from "../services/media/normalize.ts";
function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
async function refuses(bytes: Uint8Array, type: string) {
  try {
    await normalize(bytes, type);
  } catch (e) {
    assert(e instanceof MediaInputError);
    return;
  }
  throw new Error("Expected input refusal");
}
Deno.test("Rails logo styles crop transparent margins, preserve portrait aspect, and produce transparent square PNGs", async () => {
  const rgba = new Uint8Array(8 * 8 * 4);
  for (let y = 2; y < 6; y++) {
    for (let x = 3; x < 5; x++) {
      rgba[(y * 8 + x) * 4] = 255;
      rgba[(y * 8 + x) * 4 + 3] = 255;
    }
  }
  const input = await sharp(rgba, { raw: { width: 8, height: 8, channels: 4 } })
    .png().toBuffer();
  const output = await normalize(input, "image/png");
  for (
    const [bytes, size] of [[output.medium, 100], [output.thumb, 15]] as const
  ) {
    const meta = await sharp(bytes).metadata();
    assert(
      meta.format === "png" && meta.width === size && meta.height === size &&
        meta.channels === 4,
    );
    const pixels = await sharp(bytes).raw().toBuffer();
    assert(
      pixels[3] === 0 && pixels[(Math.floor(size / 2) * size) * 4 + 3] === 0,
    );
    assert(
      pixels[(Math.floor(size / 2) * size + Math.floor(size / 2)) * 4 + 3] ===
        255,
    );
    assert(!meta.exif && !meta.icc && !meta.xmp);
  }
  assert(output.etag === (await normalize(input, "image/png")).etag);
});
Deno.test("JPEG and GIF normalize, while spoofing, SVG, oversized, malformed, and invisible images are refused", async () => {
  const source = sharp({
    create: { width: 120, height: 80, channels: 3, background: "#369" },
  });
  for (
    const [bytes, type] of [[
      await source.clone().jpeg().toBuffer(),
      "image/jpeg",
    ], [await source.clone().gif().toBuffer(), "image/gif"]] as const
  ) {
    const result = await normalize(bytes, type);
    assert((await sharp(result.medium).metadata()).format === "png");
  }
  const png = await source.png().toBuffer();
  await refuses(png, "image/jpeg");
  await refuses(
    new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    "image/svg+xml",
  );
  await refuses(new Uint8Array(MAX_BODY + 1), "image/png");
  await refuses(new Uint8Array([1, 2, 3]), "image/png");
  await refuses(
    await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    }).png().toBuffer(),
    "image/png",
  );
});

// Every way a client's bytes can be corrupt is the client's error: a decoder
// message the mapping missed once surfaced as a 500.
Deno.test("corrupt PNG, JPEG and GIF bytes decode or are refused as input, never as server errors", async () => {
  const shape = { create: { width: 64, height: 64, channels: 4 as const, background: "#3a7" } };
  for (const [type, source] of [
    ["image/png", await sharp(shape).png().toBuffer()],
    ["image/jpeg", await sharp({ create: { ...shape.create, channels: 3 as const } }).jpeg().toBuffer()],
    ["image/gif", await sharp(shape).gif().toBuffer()],
  ] as const) {
    const bytes = new Uint8Array(source);
    const variants = [bytes.slice(0, bytes.length >> 1)];
    for (const at of [20, 60, 120, 200, 300]) {
      if (at + 1 >= bytes.length) continue;
      const flipped = bytes.slice();
      flipped[at] ^= 0xff;
      flipped[at + 1] ^= 0x5a;
      variants.push(flipped);
    }
    const smeared = bytes.slice();
    smeared.fill(0x41, 30, 80);
    variants.push(smeared);
    for (const variant of variants) {
      try {
        await normalize(variant, type);
      } catch (e) {
        assert(e instanceof MediaInputError, `${type}: ${e}`);
      }
    }
  }
});

// A media type is case-insensitive and may carry parameters; an exact string
// match once refused valid images.
Deno.test("a parameterised or differently cased media type names the same format", async () => {
  const png = new Uint8Array(await sharp({ create: { width: 4, height: 4, channels: 4, background: "#f00" } }).png().toBuffer());
  const plain = await normalize(png, "image/png");
  assert((await normalize(png, "Image/PNG; charset=binary")).etag === plain.etag);
});

// The processing slot once wrapped the body read, so two clients trickling
// their bodies refused every other upload with 429 until their timeouts.
Deno.test("stalled upload bodies do not hold the image processor", async () => {
  const { SignJWT } = await import("npm:jose@6.0.11");
  const { createNativeGateway } = await import("../services/media/native-gateway.ts");
  const secret = "gateway-slot-test-secret-at-least-32-bytes";
  const staged: string[] = [];
  const gateway = createNativeGateway({
    stage: async (_actor, key) => void staged.push(key),
    read: async () => null,
  }, secret);
  const token = await new SignJWT({ role: "app_user", guest: false }).setProtectedHeader({ alg: "HS256" })
    .setSubject(crypto.randomUUID()).setExpirationTime("1h").sign(new TextEncoder().encode(secret));
  const put = (body: BodyInit) =>
    gateway(new Request(`http://media/blobs/mecha-objects/${crypto.randomUUID()}.png`, {
      method: "PUT", body, headers: { authorization: `Bearer ${token}`, "content-type": "image/png" },
    }));
  const stalls = [0, 1].map(() => new TransformStream<Uint8Array, Uint8Array>());
  const pending = stalls.map((stall) => put(stall.readable));
  const png = await sharp({ create: { width: 4, height: 4, channels: 4, background: "#f00" } }).png().toBuffer();
  assert((await put(new Uint8Array(png))).status === 204, "a complete upload must not wait behind stalled bodies");
  const flood = Array.from({ length: 8 }, () => new TransformStream<Uint8Array, Uint8Array>());
  const reading = flood.slice(0, 6).map((stall) => put(stall.readable));
  assert((await put(flood[6].readable)).status === 429, "body reads must be bounded too");
  for (const stall of [...stalls, ...flood]) await stall.writable.abort();
  await Promise.allSettled([...pending, ...reading]);
  assert(staged.length === 1);
});
