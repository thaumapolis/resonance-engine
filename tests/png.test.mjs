// Tests for the golden-image comparison itself. These matter: a comparison
// function that silently always returns 0 would make every screenshot test
// vacuously pass, so its behaviour is pinned here without a browser.
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { decodePng, differenceRatio, pngSize } from './png.mjs';

const frame = (rgb, { width = 10, height = 10, alpha = 255 } = {}) => ({
  width,
  height,
  channels: 4,
  data: Buffer.from(Array(width * height).fill([rgb[0], rgb[1], rgb[2], alpha]).flat()),
});

test('identical images differ by nothing', () => {
  const image = frame([10, 20, 30]);
  assert.equal(differenceRatio(image, image), 0);
});

test('a single changed pixel is detected and scaled by area', () => {
  const base = frame([10, 20, 30]);
  const altered = frame([10, 20, 30]);
  altered.data[0] = 200;
  assert.ok(differenceRatio(base, altered) > 0, 'a colour change must register');
  assert.ok(Math.abs(differenceRatio(base, altered) - 1 / 100) < 1e-9);
});

test('differences below the per-channel threshold are tolerated', () => {
  const base = frame([10, 20, 30]);
  const near = frame([14, 21, 33]);
  assert.equal(differenceRatio(base, near, 8), 0);
  assert.ok(differenceRatio(base, near, 1) > 0.9, 'a strict threshold must reject it');
});

test('size mismatches are reported as fully different', () => {
  assert.equal(differenceRatio(frame([1, 2, 3]), frame([1, 2, 3], { width: 9 })), 1);
});

/*
 * pngSize reads the header straight out of an encoded file, so the fixture has
 * to be a real PNG rather than the decoded-object stub `frame` builds above.
 */
const encodePng = (width, height) => {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes) => crcTable.reduce(
    (c, b) => crcTable[(c ^ b) & 0xff] ^ (c >>> 8),
    0xffffffff,
  ) >>> 0;
  const chunk = (type, body) => {
    const head = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    // 4 for the length field, then type+body, then 4 for the CRC. Writing the
    // CRC at 4 + head.length is what makes the last four bytes land inside the
    // buffer: sizing this as `8 + head.length + 4` allocates two extra bytes and
    // the IEND CRC is written out of bounds, silently dropping them. Node's
    // inflate tolerated the truncated stream; Deno's reported "unexpected end of
    // file", so this fixture passed in one runtime and failed in the other.
    const out = Buffer.alloc(4 + head.length + 4);
    out.writeUInt32BE(body.length, 0);
    head.copy(out, 4);
    out.writeUInt32BE(crc(head), 4 + head.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // truecolour with alpha, what screenshots use
  const idat = deflateSync(Buffer.concat(
    Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 4)])),
  ));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

test('pngSize reads the dimensions of an encoded file', () => {
  assert.deepEqual(pngSize(encodePng(822, 198)), { width: 822, height: 198 });
  assert.deepEqual(pngSize(encodePng(1, 1)), { width: 1, height: 1 });
});

test('pngSize agrees with the full decoder it replaces here', () => {
  const file = encodePng(37, 23);
  assert.deepEqual(pngSize(file), { width: decodePng(file).width, height: decodePng(file).height });
});

test('pngSize rejects what is not a PNG rather than guessing', () => {
  assert.throws(() => pngSize(Buffer.from('nope')), /not a PNG/);
});

test('the alpha channel is not compared', () => {
  // Screenshots are composited; comparing alpha would flag invisible changes.
  assert.equal(differenceRatio(frame([9, 9, 9], { alpha: 255 }), frame([9, 9, 9], { alpha: 0 })), 0);
});

test('decodePng rejects inputs it cannot honour', () => {
  assert.throws(() => decodePng(Buffer.from('not a png at all')), /not a PNG/);
});
