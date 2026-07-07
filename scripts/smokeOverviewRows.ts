import { buildPythonReportOverviewRows } from '../src/core/reportOverview.js';

const rows = buildPythonReportOverviewRows({
  imageBase: 'demo',
  unitLabel: 'mM',
  selectedChannel: 'R',
  methodComparisonRows: [{
    Method: 'PAbs_Red',
    Family: 'RGB',
    RankMode: 'calibration_plus_stdadd',
    Score: 0.75,
    R2_cal: 0.95,
    R2_std_mean: 0.9,
    SlopeAgreement: 0.8,
    C0_median: 1.2,
    C0_sd_median: 0.1,
    beta_mean: 1.02,
    bias_index_mean: 0.02,
    LOD: 0.01,
    LOQ: 0.02,
  }],
  fitRows: [
    { Channel: 'PAbs_Red', FitType: 'StdAdd', ID: 'S1', DF: '1', C0: 1.2, C0_sd: 0.1 },
    { Channel: 'PAbs_Red', FitType: 'UnknownFromCal', ID: 'U1', DF: '1', C0: 1.3, C0_sd: 0.15 },
  ],
  expectedRefs: [
    { refId: 'REF1', label: 'Ref A', value: 1.0, sd: 0.05 },
  ],
});

const labels = rows.map((row) => row.Field);
if (!labels.includes('Quantification')) {
  throw new Error('Missing Quantification row');
}
if (labels.includes('Report') || labels.includes('Unit') || labels.includes('Mode')) {
  throw new Error('Unexpected legacy overview rows');
}
if (!labels.includes('Reference label')) {
  throw new Error('Missing external reference rows');
}
if (rows.some((row) => typeof row.Field === 'string' && row.Field.includes('Reliability'))) {
  throw new Error('Unexpected reliability rows');
}

console.log('overview row smoke passed');
