import { collectMethodComparisonIdDfGroups, fitLineWithCovariance, stdAddC0SdFromFit } from '../src/core/fitting.js';

const TOLERANCE = 1e-10;

interface ExpectedFit {
  n: number;
  slope: number;
  intercept: number;
  r2: number;
  rmse: number;
  covariance: [[number, number], [number, number]];
  weights: number[];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertClose(actual: number, expected: number, message: string, tolerance = TOLERANCE): void {
  if (Number.isNaN(expected)) {
    assert(Number.isNaN(actual), `${message}. Expected NaN, got ${String(actual)}`);
    return;
  }

  const scale = Math.max(1, Math.abs(expected));
  assert(
    Math.abs(actual - expected) <= tolerance * scale,
    `${message}. Expected ${expected}, got ${actual}`,
  );
}

function assertFit(actual: ReturnType<typeof fitLineWithCovariance>, expected: ExpectedFit, label: string): void {
  assert(actual.fitMethod === 'robust_irls_no_sd_weighting', `${label} fit method`);
  assert(actual.n === expected.n, `${label} n`);
  assertClose(actual.slope, expected.slope, `${label} slope`);
  assertClose(actual.intercept, expected.intercept, `${label} intercept`);
  assertClose(actual.r2, expected.r2, `${label} R2`);
  assertClose(actual.rmse, expected.rmse, `${label} RMSE`);

  for (let row = 0; row < 2; row += 1) {
    for (let col = 0; col < 2; col += 1) {
      assertClose(actual.covariance[row][col], expected.covariance[row][col], `${label} covariance[${row}][${col}]`);
    }
  }

  expected.weights.forEach((weight, index) => {
    assertClose(actual.weights[index], weight, `${label} weight[${index}]`);
  });
}

function testOrdinaryLine(): void {
  const fit = fitLineWithCovariance([0, 1, 2, 3], [1, 3, 5, 7]);

  assertFit(fit, {
    n: 4,
    slope: 2.0,
    intercept: 0.9999999999999983,
    r2: 1.0,
    rmse: 1.7492619859936476e-15,
    covariance: [
      [1.2239669982569761e-30, -1.8359504973854637e-30],
      [-1.8359504973854637e-30, 4.283884493899415e-30],
    ],
    weights: [1, 1, 1, 1],
  }, 'ordinary non-outlier line');
}

function testDownweightedOutlier(): void {
  const fit = fitLineWithCovariance([0, 1, 2, 3, 4, 5, 6], [1, 3, 5, 30, 9, 11, 13]);

  assertFit(fit, {
    n: 7,
    slope: 1.9999999999999998,
    intercept: 2.8760871726510633,
    r2: 0.17348019674172166,
    rmse: 8.170835869234224,
    covariance: [
      [1.8492859273274762, -5.547857781982429],
      [-5.5478577819824295, 24.569633724265007],
    ],
    weights: [1, 1, 1, 0.5328805855197746, 1, 1, 1],
  }, 'downweighted outlier line');

  assert(fit.weights[3] < 1, 'downweighted outlier line should reduce the outlier weight');
}

function testCovariance(): void {
  const fit = fitLineWithCovariance([0, 1, 2, 3], [1.1, 2.9, 5.2, 6.8]);

  assertFit(fit, {
    n: 4,
    slope: 1.9261090828832508,
    intercept: 1.0761090828832514,
    r2: 0.9953550937909877,
    rmse: 0.1481458127575092,
    covariance: [
      [0.005156230970404485, -0.007356491687464702],
      [-0.007356491687464702, 0.01766895362827367],
    ],
    weights: [1, 1, 0.48868934967862404, 1],
  }, 'force_zero=false covariance');
}

function testTwoPointCovariance(): void {
  const fit = fitLineWithCovariance([0, 1], [1, 3]);

  assertClose(fit.slope, 2.0, 'two-point slope');
  assertClose(fit.intercept, 0.9999999999999998, 'two-point intercept');
  assert(Number.isNaN(fit.covariance[0][0]), 'two-point covariance[0][0] should be NaN');
  assert(Number.isNaN(fit.covariance[0][1]), 'two-point covariance[0][1] should be NaN');
  assert(Number.isNaN(fit.covariance[1][0]), 'two-point covariance[1][0] should be NaN');
  assert(Number.isNaN(fit.covariance[1][1]), 'two-point covariance[1][1] should be NaN');
}

function testForceZeroCovariance(): void {
  const fit = fitLineWithCovariance([1, 2, 3], [2.1, 4.0, 6.2], undefined, true);

  assertFit(fit, {
    n: 3,
    slope: 2.061459133658749,
    intercept: 0.0,
    r2: 0.9980001942495336,
    rmse: 0.07491854336305774,
    covariance: [
      [0.0003063565041990611, 0],
      [0, 0],
    ],
    weights: [1, 0.3474205473133811, 1],
  }, 'force_zero=true covariance');
}

function testStandardAdditionC0Sd(): void {
  const fit = fitLineWithCovariance([0, 1, 2, 3], [2.1, 4.0, 6.1, 8.2]);
  const c0 = stdAddC0SdFromFit(fit);

  assertFit(fit, {
    n: 4,
    slope: 2.0398607017049257,
    intercept: 2.040557193180297,
    r2: 0.9994236031642435,
    rmse: 0.05477358423649664,
    covariance: [
      [0.0011898911715996637, -0.001787424345413363],
      [-0.0017874243454133628, 0.004177557040668159],
    ],
    weights: [1, 0.9826781967779142, 1, 1],
  }, 'standard-addition fit');
  assertClose(c0.c0, 1.0003414407046467, 'standard-addition C0');
  assertClose(c0.c0Sd, 0.046363199686337564, 'standard-addition C0_sd');
}

function testMethodComparisonIdDfGrouping(): void {
  const groups = collectMethodComparisonIdDfGroups([
    { FitType: 'Calibration', Channel: 'R', ID: '', DF: '' },
    { FitType: 'StdAdd', Channel: 'R', ID: '1', DF: 100 },
    { FitType: 'StdAdd', Channel: 'G', ID: '1', DF: 100 },
    { FitType: 'StdAdd', Channel: 'R', ID: '2', DF: 50 },
    { FitType: 'StdAdd', Channel: 'B', ID: 'Sample / A', DF: 50 },
    { FitType: 'StdAdd', Channel: 'B', ID: 'Sample / A', DF: 25.5 },
  ]);

  assert(groups.length === 4, 'method-comparison grouping should deduplicate channels within each ID + DF pair');
  assert(groups[0].sampleId === '1' && groups[0].dilutionFactor === 100, 'first ID + DF group');
  assert(groups[0].fileSuffix === 'ID1_DF100', 'numeric ID + DF filename suffix');
  assert(groups[1].sampleId === '2' && groups[1].dilutionFactor === 50, 'second ID + DF group');
  assert(groups[2].fileSuffix === 'IDSample_A_DF25.5', 'sanitized decimal ID + DF filename suffix');
  assert(groups[3].fileSuffix === 'IDSample_A_DF50', 'sanitized ID + DF filename suffix');
}

testOrdinaryLine();
testDownweightedOutlier();
testCovariance();
testTwoPointCovariance();
testForceZeroCovariance();
testStandardAdditionC0Sd();
testMethodComparisonIdDfGrouping();

console.log('fitting parity smoke passed');
