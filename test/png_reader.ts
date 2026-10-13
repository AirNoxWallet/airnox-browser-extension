import { inflateSync } from 'node:zlib';

// A minimal PNG reader for the icon tests: 8-bit RGBA (colour type 6), not
// interlaced, which is what the brand kit writes. Anything else throws, so a
// re-export in another format fails the test instead of being misread.
// PNG specification (W3C, third edition), sections 5, 7.2, 9 and 11.2.

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly pixels: Buffer; // width * height * 4 bytes, row-major RGBA
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
}

export function readRgbaPng(file: Buffer): RgbaImage {
  if (!file.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('not a PNG');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString('latin1', offset + 4, offset + 8);
    const data = file.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [depth, colour, , , interlace] = data.subarray(8, 13);
      if (depth !== 8 || colour !== 6 || interlace !== 0) {
        throw new Error(`unsupported PNG: depth ${depth} colour ${colour}`);
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? pixels[y * stride + x - 4] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4] : 0;
      let predictor: number;
      switch (filter) {
        case 0:
          predictor = 0;
          break;
        case 1:
          predictor = a;
          break;
        case 2:
          predictor = b;
          break;
        case 3:
          predictor = (a + b) >> 1;
          break;
        case 4:
          predictor = paeth(a, b, c);
          break;
        default:
          throw new Error(`bad filter ${filter} on row ${y}`);
      }
      pixels[y * stride + x] = (line[x] + predictor) & 0xff;
    }
  }
  return { width, height, pixels };
}
