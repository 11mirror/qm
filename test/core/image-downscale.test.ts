import { deflateSync } from "node:zlib";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  downscaleVisionImage,
  MAX_VISION_IMAGE_DIMENSION,
  sniffImageDimensions,
} from "../../src/core/image-downscale.ts";

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodedPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      rows.fill((x ^ y) & 0xff, y * (width * 3 + 1) + 1 + x * 3, y * (width * 3 + 1) + 4 + x * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function gif(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(10);
  bytes.write("GIF89a", 0, "ascii");
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes;
}

function jpeg(width: number, height: number): Buffer {
  const bytes = Buffer.from("ffd8ffe000040000ffc0000b080000000001011100ffd9", "hex");
  bytes.writeUInt16BE(height, 13);
  bytes.writeUInt16BE(width, 15);
  return bytes;
}

function webp(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8X", 12, "ascii");
  bytes.writeUInt32LE(10, 16);
  const encodedWidth = width - 1;
  const encodedHeight = height - 1;
  bytes[24] = encodedWidth & 0xff;
  bytes[25] = (encodedWidth >> 8) & 0xff;
  bytes[26] = (encodedWidth >> 16) & 0xff;
  bytes[27] = encodedHeight & 0xff;
  bytes[28] = (encodedHeight >> 8) & 0xff;
  bytes[29] = (encodedHeight >> 16) & 0xff;
  return bytes;
}

test("sniffImageDimensions reads PNG, JPEG, GIF, and WebP headers", () => {
  assert.deepEqual(sniffImageDimensions(png(640, 480)), { width: 640, height: 480, format: "png" });
  assert.deepEqual(sniffImageDimensions(jpeg(800, 600)), { width: 800, height: 600, format: "jpeg" });
  assert.deepEqual(sniffImageDimensions(gif(320, 240)), { width: 320, height: 240, format: "gif" });
  assert.deepEqual(sniffImageDimensions(webp(1024, 768)), { width: 1024, height: 768, format: "webp" });
});

test("downscaleVisionImage leaves small images untouched", async () => {
  const small = png(MAX_VISION_IMAGE_DIMENSION, 900);
  const result = await downscaleVisionImage(small, "image/png");
  assert.equal(result.bytes, small);
  assert.equal(result.mimeType, "image/png");
});

test("downscaleVisionImage shrinks an oversized image to fit the vision limit", async () => {
  const result = await downscaleVisionImage(encodedPng(2400, 1800), "image/png");
  const dimensions = sniffImageDimensions(result.bytes);
  assert.ok(dimensions);
  assert.equal(Math.max(dimensions.width, dimensions.height), MAX_VISION_IMAGE_DIMENSION);
  assert.equal(result.mimeType, `image/${dimensions.format}`);
});

test("downscaleVisionImage returns the original bytes when the image cannot be decoded", async () => {
  const unreadable = png(3000, 2000);
  const result = await downscaleVisionImage(unreadable, "image/png");
  assert.equal(result.bytes, unreadable);
  assert.equal(result.mimeType, "image/png");
});

test("sniffing a large image with many segments takes linear time", () => {
  const segments = Buffer.alloc(1024 * 1024, Buffer.from([0xff, 0xfe, 0x00, 0x02]));
  const crafted = Buffer.concat([Buffer.from([0xff, 0xd8]), segments]);
  const started = performance.now();
  assert.equal(sniffImageDimensions(crafted), undefined);
  assert.ok(performance.now() - started < 2_000);
});
