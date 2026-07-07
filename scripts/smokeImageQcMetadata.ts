import { computePythonImageQcInfo } from '../src/core/imageQc.js';

const imageData = {
  width: 2,
  height: 2,
  data: new Uint8ClampedArray([
    100, 100, 100, 255,
    110, 110, 110, 255,
    120, 120, 120, 255,
    130, 130, 130, 255,
  ]),
} as ImageData;

const wells = [
  { wellId: 'A1', row: 0, col: 0, x: 0, y: 0 },
  { wellId: 'A2', row: 0, col: 1, x: 10, y: 0 },
  { wellId: 'B1', row: 1, col: 0, x: 0, y: 10 },
  { wellId: 'B2', row: 1, col: 1, x: 10, y: 10 },
];

const measurements = [
  {
    wellId: 'A1',
    row: 0,
    col: 0,
    roiPixels: 10,
    bgPixels: 0,
    backgroundModel: 'annular' as const,
    rgbWell: { r: 100, g: 100, b: 100 },
    rgbBackground: { r: 100, g: 100, b: 100 },
    pabs: { r: 0, g: 0, b: 0 },
    warnings: [],
    roiUsedPixels: 10,
  },
  {
    wellId: 'A2',
    row: 0,
    col: 1,
    roiPixels: 12,
    bgPixels: 0,
    backgroundModel: 'annular' as const,
    rgbWell: { r: 102, g: 102, b: 102 },
    rgbBackground: { r: 102, g: 102, b: 102 },
    pabs: { r: 0, g: 0, b: 0 },
    warnings: [],
    roiUsedPixels: 12,
  },
  {
    wellId: 'B1',
    row: 1,
    col: 0,
    roiPixels: 14,
    bgPixels: 0,
    backgroundModel: 'annular' as const,
    rgbWell: { r: 104, g: 104, b: 104 },
    rgbBackground: { r: 104, g: 104, b: 104 },
    pabs: { r: 0, g: 0, b: 0 },
    warnings: [],
    roiUsedPixels: 14,
  },
  {
    wellId: 'B2',
    row: 1,
    col: 1,
    roiPixels: 16,
    bgPixels: 0,
    backgroundModel: 'annular' as const,
    rgbWell: { r: 106, g: 106, b: 106 },
    rgbBackground: { r: 106, g: 106, b: 106 },
    pabs: { r: 0, g: 0, b: 0 },
    warnings: [],
    roiUsedPixels: 16,
  },
];

const info = computePythonImageQcInfo(imageData, wells, measurements, 'demo.png', { width: 2, height: 2 });

if (info.analysis_image_source !== 'original') {
  throw new Error(`Unexpected analysis image source: ${info.analysis_image_source}`);
}

if (info.original_image_path !== 'demo.png') {
  throw new Error(`Unexpected original path: ${info.original_image_path}`);
}

if (info.initial_image_qc !== 'FAIL') {
  throw new Error(`Unexpected initial QC: ${info.initial_image_qc}`);
}

console.log('image qc metadata smoke passed');
