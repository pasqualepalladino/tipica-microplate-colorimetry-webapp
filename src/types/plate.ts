export interface WellCenter {
  wellId: string;
  row: number;
  col: number;
  x: number;
  y: number;
}
/**
 * Nominal plate dimensions and the rectangular region visible in an image.
 * All offsets are zero-based nominal plate indices.
 */
export interface PlateRegionDefinition {
  plateRows: number;
  plateColumns: number;
  visibleRows: number;
  visibleColumns: number;
  rowOffset: number;
  columnOffset: number;
}