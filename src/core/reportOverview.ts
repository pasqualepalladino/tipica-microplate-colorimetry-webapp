import type { FitChannel } from '../types/plateMap';
import type { ExpectedRef } from '../core/plateConfigurator';

export type ReportOverviewRow = Record<string, string | number | boolean | null | undefined>;

export interface PythonReportOverviewRowOptions {
  imageBase: string;
  unitLabel: string;
  selectedChannel: FitChannel;
  methodComparisonRows: ReportOverviewRow[];
  fitRows: ReportOverviewRow[];
  expectedRefs: ExpectedRef[];
  rankings?: { score: number }[];
}

function numericRowValue(row: ReportOverviewRow | undefined, key: string): number {
  const value = row?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
}

function stringRowValue(row: ReportOverviewRow | undefined, key: string): string {
  const value = row?.[key];
  return typeof value === 'string' ? value : '';
}

function expectedRefKey(label: string, index: number): string {
  const trimmed = label.trim();
  const fallback = `Expected_${index}`;
  const base = trimmed || fallback;
  const safe = base
    .replace(/[^A-Za-z0-9_ /\\-]+/g, '')
    .replace(/[ /\\-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return safe || fallback;
}

function reportChannelName(channel: FitChannel): string {
  return channel === 'R' ? 'PAbs_Red' : channel === 'G' ? 'PAbs_Green' : 'PAbs_Blue';
}

export function buildPythonReportOverviewRows(options: PythonReportOverviewRowOptions): ReportOverviewRow[] {
  const best = [...options.methodComparisonRows].sort((a, b) => {
    const scoreA = numericRowValue(a, 'Score');
    const scoreB = numericRowValue(b, 'Score');
    if (Number.isFinite(scoreA) && Number.isFinite(scoreB)) {
      return scoreB - scoreA;
    }
    if (Number.isFinite(scoreA)) {
      return -1;
    }
    if (Number.isFinite(scoreB)) {
      return 1;
    }
    return 0;
  })[0] ?? {};

  const selectedName = stringRowValue(best, 'Method') || reportChannelName(options.selectedChannel);
  const rows: ReportOverviewRow[] = [];
  const quantification = options.rankings?.some((ranking) => Number.isFinite(ranking.score) && ranking.score > 0) ? 'available' : 'not available';
  rows.push({ Field: 'Quantification', Value: quantification });

  rows.push({ Field: 'Selected method from rank', Value: selectedName });
  rows.push({ Field: 'Selected family', Value: stringRowValue(best, 'Family') || 'PAbs' });
  rows.push({ Field: 'Ranking mode', Value: stringRowValue(best, 'RankMode') });
  rows.push({ Field: 'Selected method score', Value: numericRowValue(best, 'Score') });
  rows.push({ Field: 'R2 calibration', Value: numericRowValue(best, 'R2_cal') });
  rows.push({ Field: 'R2 std add', Value: numericRowValue(best, 'R2_std_mean') });
  rows.push({ Field: 'Slope agreement', Value: numericRowValue(best, 'SlopeAgreement') });
  rows.push({ Field: 'C0 median', Value: numericRowValue(best, 'C0_median') });
  rows.push({ Field: 'C0 SD median', Value: numericRowValue(best, 'C0_sd_median') });
  rows.push({ Field: 'beta (mean)', Value: numericRowValue(best, 'beta_mean') });
  rows.push({ Field: 'Bias index (mean)', Value: numericRowValue(best, 'bias_index_mean') });
  rows.push({ Field: 'LOD', Value: numericRowValue(best, 'LOD') });
  rows.push({ Field: 'LOQ', Value: numericRowValue(best, 'LOQ') });

  const selectedRows = options.fitRows.filter((row) => stringRowValue(row, 'Channel') === selectedName);
  selectedRows.forEach((row) => {
    if (row.FitType === 'StdAdd' || row.FitType === 'UnknownFromCal' || row.FitType === 'UnknownFromEpsilon') {
      const c0 = numericRowValue(row, 'C0');
      if (Number.isFinite(c0)) {
        rows.push({ Field: `${row.FitType} ID=${row.ID ?? ''} DF=${row.DF ?? ''} C0 (${options.unitLabel})`, Value: c0 });
      }
      const c0Sd = numericRowValue(row, 'C0_sd');
      if (Number.isFinite(c0Sd)) {
        rows.push({ Field: `${row.FitType} ID=${row.ID ?? ''} DF=${row.DF ?? ''} C0 SD (${options.unitLabel})`, Value: c0Sd });
      }
    }
  });

  options.expectedRefs.forEach((ref, index) => {
    const key = expectedRefKey(ref.label || ref.refId || `Reference ${index + 1}`, index + 1);
    const referenceValue = typeof ref.value === 'number' && Number.isFinite(ref.value) ? ref.value : Number.NaN;
    const referenceSd = typeof ref.sd === 'number' && Number.isFinite(ref.sd) ? ref.sd : Number.NaN;
    const label = ref.label || ref.refId || `Reference ${index + 1}`;

    rows.push({ Field: 'Reference label', Value: label });
    if (Number.isFinite(referenceValue)) {
      rows.push({ Field: `Reference value (${options.unitLabel})`, Value: referenceValue });
    }
    if (Number.isFinite(referenceSd)) {
      rows.push({ Field: `Reference SD (${options.unitLabel})`, Value: referenceSd });
    }

    const deltaKey = `delta_expected_${key}`;
    const recoveryKey = `recovery_pct_${key}`;
    const delta = numericRowValue(best, deltaKey);
    const recovery = numericRowValue(best, recoveryKey);
    if (Number.isFinite(delta)) {
      rows.push({ Field: `${selectedName} delta (${options.unitLabel})`, Value: delta });
    }
    if (Number.isFinite(recovery)) {
      rows.push({ Field: `${selectedName} recovery (%)`, Value: recovery });
    }
  });

  return rows;
}
