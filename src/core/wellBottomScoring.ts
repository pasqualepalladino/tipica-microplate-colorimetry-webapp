export interface WellBottomGradientImage {
  width: number;
  height: number;
  data: Float32Array;
}

const GAUSSIAN_5_KERNEL = [1, 4, 6, 4, 1].map((value) => value / 16);

function clampIndex(value: number, maxInclusive: number): number {
  return Math.max(0, Math.min(maxInclusive, value));
}

function gaussianBlur5x5(input: Float32Array, width: number, height: number): Float32Array {
  const tmp = new Float32Array(width * height);
  const output = new Float32Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;

      for (let k = -2; k <= 2; k += 1) {
        const xx = clampIndex(x + k, width - 1);
        sum += input[y * width + xx] * GAUSSIAN_5_KERNEL[k + 2];
      }

      tmp[y * width + x] = sum;
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;

      for (let k = -2; k <= 2; k += 1) {
        const yy = clampIndex(y + k, height - 1);
        sum += tmp[yy * width + x] * GAUSSIAN_5_KERNEL[k + 2];
      }

      output[y * width + x] = sum;
    }
  }

  return output;
}

export function buildWellBottomGradientImage(imageData: ImageData): WellBottomGradientImage {
  const { data, width, height } = imageData;
  const purple = new Float32Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];

      purple[y * width + x] = 0.5 * (red + blue) - green;
    }
  }

  const blurred = gaussianBlur5x5(purple, width, height);
  const gradient = new Float32Array(width * height);

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i00 = blurred[(y - 1) * width + (x - 1)];
      const i01 = blurred[(y - 1) * width + x];
      const i02 = blurred[(y - 1) * width + (x + 1)];
      const i10 = blurred[y * width + (x - 1)];
      const i12 = blurred[y * width + (x + 1)];
      const i20 = blurred[(y + 1) * width + (x - 1)];
      const i21 = blurred[(y + 1) * width + x];
      const i22 = blurred[(y + 1) * width + (x + 1)];

      const gx = -i00 + i02 - (2 * i10) + (2 * i12) - i20 + i22;
      const gy = i00 + (2 * i01) + i02 - i20 - (2 * i21) - i22;

      gradient[y * width + x] = Math.hypot(gx, gy);
    }
  }

  return {
    width,
    height,
    data: gradient,
  };
}

export function ringScore(
  gradientImage: WellBottomGradientImage,
  cx: number,
  cy: number,
  radius: number,
  band = 1.10,
): number | null {
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(radius) || radius < 2 || band <= 0) {
    return null;
  }

  const { data, width, height } = gradientImage;
  const x0 = Math.max(0, Math.floor(cx - radius - band - 2));
  const x1 = Math.min(width - 1, Math.ceil(cx + radius + band + 3));
  const y0 = Math.max(0, Math.floor(cy - radius - band - 2));
  const y1 = Math.min(height - 1, Math.ceil(cy + radius + band + 3));
  let sum = 0;
  let count = 0;

  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const distance = Math.hypot(x - cx, y - cy);

      if (Math.abs(distance - radius) > band) {
        continue;
      }

      sum += data[y * width + x];
      count += 1;
    }
  }

  if (count < 10) {
    return null;
  }

  return sum / count;
}
