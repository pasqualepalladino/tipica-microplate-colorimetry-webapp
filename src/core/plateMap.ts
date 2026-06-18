import type { WellConfig } from '../types/plateMap';

const ROW_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const COL_COUNT = 12;

function wellIdFor(row: number, col: number): string {
  return `${ROW_LABELS[row - 1]}${col}`;
}

export function createEmptyPlateMap(): WellConfig[] {
  const plateMap: WellConfig[] = [];

  for (let row = 1; row <= ROW_LABELS.length; row += 1) {
    for (let col = 1; col <= COL_COUNT; col += 1) {
      plateMap.push({
        wellId: wellIdFor(row, col),
        row,
        col,
        role: 'EMPTY',
        concentration: null,
        sampleId: '',
        dilutionFactor: 1,
      });
    }
  }

  return plateMap;
}
