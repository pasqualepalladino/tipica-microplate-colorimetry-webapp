import type { ChangeEvent } from 'react';
import { useEffect, useMemo, useRef, useState , type ReactNode} from 'react';
import type { WellConfig } from '../types/plateMap';
import {
  applyTagToRow,
  buildDefaultPlateDefaults,
  buildPlateMapTemplateCsv,
  buildUnitLabel,
  collectExpectedRefs,
  collectPlateState,
  importPlateMapCsv,
  parseUnitLabel,
  PLATE_FORMATS,
  plateDataToWellConfigs,
  rowLabelFromIndex,
  type CellGrid,
  type ExpectedRef,
  type PlateCellType,
  type PlateDefaults,
  type PlateEditorSnapshot,
  type PlateFormatLabel,
  wellConfigsToPlateEditorState,
} from '../core/plateConfigurator';

interface PlateMapEditorProps {
  plateMap: WellConfig[];
  unitLabel: string;
  expectedRefs: ExpectedRef[];
  editorSnapshot?: PlateEditorSnapshot | null;
  storedCalibrationLoaded: boolean;
  onChange: (plateMap: WellConfig[]) => void;
  onClear: () => void;
  onExpectedRefsChange?: (expectedRefs: ExpectedRef[]) => void;
  onUnitLabelChange?: (unitLabel: string) => void;
  onEditorSnapshotChange?: (snapshot: PlateEditorSnapshot) => void;
  onHelpRequest?: () => void;
  onStartNewAnalysis?: () => void;
  configuratorMediaActive?: boolean;
  reviewContent?: ReactNode;
  workflowContent?: ReactNode;
}

interface ExpectedRefRow {
  refId: string;
  label: string;
  value: string;
  sd: string;
}

function inferPlateFormatLabel(nrow: number, ncol: number): PlateFormatLabel {
  for (const label of Object.keys(PLATE_FORMATS) as PlateFormatLabel[]) {
    const [rows, cols] = PLATE_FORMATS[label];
    if (rows === nrow && cols === ncol) {
      return label;
    }
  }
  return '96-well (8 x 12)';
}

function cellIsCType(text: string): boolean {
  const tokens = text.trim().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length < 2) {
    return false;
  }
  return tokens[1].toUpperCase() === 'C';
}

function csvFileName(label: string, ext: string): string {
  const safe = label.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `${safe || 'plate_map'}${ext}`;
}

function downloadText(content: string, fileName: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = fileName;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function PlateMapEditor({
  plateMap,
  unitLabel,
  expectedRefs,
  editorSnapshot,
  storedCalibrationLoaded,
  onChange,
  onClear,
  onExpectedRefsChange,
  onUnitLabelChange,
  onEditorSnapshotChange,
  onHelpRequest,
  onStartNewAnalysis,
  configuratorMediaActive = false,
  reviewContent,
  workflowContent,
}: PlateMapEditorProps) {
  const unitParts = useMemo(() => parseUnitLabel(unitLabel), [unitLabel]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastEmittedSignatureRef = useRef<string>('');
  const lastEmittedExpectedRefsSignatureRef = useRef<string>('');
  const lastEmittedEditorSnapshotSignatureRef = useRef<string>('');

  const initial = useMemo(() => {
    if (editorSnapshot) {
      return {
        grid: editorSnapshot.grid,
        nrow: editorSnapshot.nrow,
        ncol: editorSnapshot.ncol,
        plateFormat: inferPlateFormatLabel(editorSnapshot.nrow, editorSnapshot.ncol),
        defaults: editorSnapshot.defaults,
        idDfPriority: editorSnapshot.idDfPriority,
      };
    }

    const parsed = wellConfigsToPlateEditorState(plateMap);
    const plateFormat = inferPlateFormatLabel(parsed.nrow, parsed.ncol);
    return {
      grid: parsed.grid,
      nrow: parsed.nrow,
      ncol: parsed.ncol,
      plateFormat,
      defaults: parsed.defaults,
      idDfPriority: 'row' as const,
    };
  }, [editorSnapshot, plateMap]);

  const [grid, setGrid] = useState<CellGrid>(initial.grid);
  const [plateFormat, setPlateFormat] = useState<PlateFormatLabel>(initial.plateFormat);
  const [nrow, setNrow] = useState<number>(initial.nrow);
  const [ncol, setNcol] = useState<number>(initial.ncol);
  const [defaults, setDefaults] = useState<PlateDefaults>(initial.defaults);
  const [unitBase, setUnitBase] = useState(unitParts.base || 'mM');
  const [unitExp, setUnitExp] = useState(unitParts.exp || '0');
  const [idDfPriority, setIdDfPriority] = useState<'row' | 'col'>(initial.idDfPriority);
  const [expectedRows, setExpectedRows] = useState<ExpectedRefRow[]>(() => {
    if (expectedRefs.length === 0) {
      return [{ refId: '', label: '', value: '', sd: '' }];
    }

    return expectedRefs.map((entry) => ({
      refId: entry.refId,
      label: entry.label,
      value: String(entry.value),
      sd: entry.sd === null ? '' : String(entry.sd),
    }));
  });

  useEffect(() => {
    setUnitBase(unitParts.base || 'mM');
    setUnitExp(unitParts.exp || '0');
  }, [unitParts.base, unitParts.exp]);

  useEffect(() => {
    if (editorSnapshot) {
      const incomingSnapshot = JSON.stringify(editorSnapshot);
      if (incomingSnapshot === lastEmittedEditorSnapshotSignatureRef.current) {
        return;
      }

      setGrid(editorSnapshot.grid);
      setNrow(editorSnapshot.nrow);
      setNcol(editorSnapshot.ncol);
      setPlateFormat(inferPlateFormatLabel(editorSnapshot.nrow, editorSnapshot.ncol));
      setDefaults(editorSnapshot.defaults);
      setIdDfPriority(editorSnapshot.idDfPriority);
      setExtendedView(editorSnapshot.extendedView ?? true);
      return;
    }

    const incoming = JSON.stringify(plateMap);
    if (incoming === lastEmittedSignatureRef.current) {
      return;
    }

    const parsed = wellConfigsToPlateEditorState(plateMap);
    const nextFormat = inferPlateFormatLabel(parsed.nrow, parsed.ncol);

    setGrid(parsed.grid);
    setNrow(parsed.nrow);
    setNcol(parsed.ncol);
    setPlateFormat(nextFormat);
    setDefaults(parsed.defaults);
    setIdDfPriority('row');
    setExtendedView(true);
  }, [editorSnapshot, plateMap]);

  useEffect(() => {
    const incoming = JSON.stringify(expectedRefs);
    if (incoming === lastEmittedExpectedRefsSignatureRef.current) {
      return;
    }

    if (expectedRefs.length === 0) {
      setExpectedRows([{ refId: '', label: '', value: '', sd: '' }]);
      return;
    }

    setExpectedRows(expectedRefs.map((entry) => ({
      refId: entry.refId,
      label: entry.label,
      value: String(entry.value),
      sd: entry.sd === null ? '' : String(entry.sd),
    })));
  }, [expectedRefs]);

  const [extendedView, setExtendedView] = useState(editorSnapshot?.extendedView ?? true);

  const collectedExpectedRefs: ExpectedRef[] = useMemo(
    () => collectExpectedRefs(expectedRows),
    [expectedRows],
  );

  useEffect(() => {
    const state = collectPlateState(grid, defaults, nrow, ncol, {
      unitBase,
      unitExp,
      expectedRefs: collectedExpectedRefs,
      idDfPriority,
      extendedView,
    });

    const nextPlateMap = plateDataToWellConfigs(state.data, nrow, ncol);
    lastEmittedSignatureRef.current = JSON.stringify(nextPlateMap);
    onChange(nextPlateMap);
  }, [
    collectedExpectedRefs,
    defaults,
    grid,
    idDfPriority,
    ncol,
    nrow,
    onChange,
    unitBase,
    unitExp,
  ]);

  useEffect(() => {
    if (!onUnitLabelChange) {
      return;
    }
    onUnitLabelChange(buildUnitLabel(unitBase, unitExp));
  }, [onUnitLabelChange, unitBase, unitExp]);

  useEffect(() => {
    if (!onExpectedRefsChange) {
      return;
    }

    lastEmittedExpectedRefsSignatureRef.current = JSON.stringify(collectedExpectedRefs);
    onExpectedRefsChange(collectedExpectedRefs);
  }, [collectedExpectedRefs, onExpectedRefsChange]);

  useEffect(() => {
    if (!onEditorSnapshotChange) {
      return;
    }

    const snapshot: PlateEditorSnapshot = {
      grid,
      defaults,
      nrow,
      ncol,
      idDfPriority,
      extendedView,
    };
    lastEmittedEditorSnapshotSignatureRef.current = JSON.stringify(snapshot);
    onEditorSnapshotChange(snapshot);
  }, [defaults, extendedView, grid, idDfPriority, ncol, nrow, onEditorSnapshotChange]);

  const configuredWellCount = useMemo(() => {
    const state = collectPlateState(grid, defaults, nrow, ncol, {
      unitBase,
      unitExp,
      expectedRefs: collectedExpectedRefs,
      idDfPriority,
      extendedView,
    });
    return state.data.length;
  }, [
    collectedExpectedRefs,
    defaults,
    grid,
    idDfPriority,
    ncol,
    nrow,
    unitBase,
    unitExp,
  ]);

  const plateCellWidthClass = useMemo(() => {
    if (extendedView) {
      if (ncol <= 12) return 'plate-config-cells-8';
      if (ncol <= 24) return 'plate-config-cells-6';
      return 'plate-config-cells-5';
    }

    if (ncol <= 12) return 'plate-config-cells-6';
    if (ncol <= 24) return 'plate-config-cells-5';
    return 'plate-config-cells-4';
  }, [extendedView, ncol]);

  const setCell = (row: number, col: number, value: string) => {
    const key = `${row}_${col}`;
    setGrid((current) => ({ ...current, [key]: value }));
  };

  const setRowDefault = (row: number, field: 'rowDf' | 'rowId', value: string) => {
    setDefaults((current) => ({
      ...current,
      [field]: {
        ...current[field],
        [row]: value,
      },
    }));
  };

  const setColDefault = (col: number, field: 'colDf' | 'colId', value: string) => {
    setDefaults((current) => ({
      ...current,
      [field]: {
        ...current[field],
        [col]: value,
      },
    }));
  };

  const handleCopyRowA = () => {
    setGrid((current) => {
      const next = { ...current };
      for (let row = 1; row < nrow; row += 1) {
        for (let col = 0; col < ncol; col += 1) {
          next[`${row}_${col}`] = current[`0_${col}`] ?? '';
        }
      }
      return next;
    });

    setDefaults((current) => {
      const next = {
        ...current,
        rowDf: { ...current.rowDf },
        rowId: { ...current.rowId },
        colDf: { ...current.colDf },
        colId: { ...current.colId },
      };
      for (let row = 1; row < nrow; row += 1) {
        next.rowDf[row] = current.rowDf[0] ?? '1';
        next.rowId[row] = current.rowId[0] ?? rowLabelFromIndex(0);
      }
      return next;
    });
  };

  const handleCopyCol1 = () => {
    setGrid((current) => {
      const next = { ...current };
      for (let col = 1; col < ncol; col += 1) {
        for (let row = 0; row < nrow; row += 1) {
          next[`${row}_${col}`] = current[`${row}_0`] ?? '';
        }
      }
      return next;
    });

    setDefaults((current) => {
      const next = {
        ...current,
        rowDf: { ...current.rowDf },
        rowId: { ...current.rowId },
        colDf: { ...current.colDf },
        colId: { ...current.colId },
      };
      for (let col = 1; col < ncol; col += 1) {
        next.colDf[col] = current.colDf[0] ?? '';
        next.colId[col] = current.colId[0] ?? '1';
      }
      return next;
    });
  };

  const handleTagRow = (row: number, tag: PlateCellType) => {
    setGrid((current) => applyTagToRow(current, row, ncol, tag, storedCalibrationLoaded));
  };

  const handlePlateFormatChange = (label: PlateFormatLabel) => {
    const [rows, cols] = PLATE_FORMATS[label];
    setPlateFormat(label);

    setGrid((current) => {
      const next: CellGrid = {};
      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const key = `${row}_${col}`;
          if (current[key] !== undefined) {
            next[key] = current[key];
          }
        }
      }
      return next;
    });

    setNrow(rows);
    setNcol(cols);

    setDefaults((current) => {
      const next = buildDefaultPlateDefaults(rows, cols);
      for (let row = 0; row < rows; row += 1) {
        if (current.rowDf[row] !== undefined) next.rowDf[row] = current.rowDf[row];
        if (current.rowId[row] !== undefined) next.rowId[row] = current.rowId[row];
      }
      for (let col = 0; col < cols; col += 1) {
        if (current.colDf[col] !== undefined) next.colDf[col] = current.colDf[col];
        if (current.colId[col] !== undefined) next.colId[col] = current.colId[col];
      }
      return next;
    });
  };

  const handleExportCsvTemplate = () => {
    const csv = buildPlateMapTemplateCsv(grid, defaults, nrow, ncol, idDfPriority);
    downloadText(csv, csvFileName(plateFormat, '_template.csv'), 'text/csv;charset=utf-8');
  };

  const handleImportCsvClick = () => {
    fileInputRef.current?.click();
  };

  const handleImportCsv = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const imported = importPlateMapCsv(text, nrow, ncol);
      setGrid((current) => {
        const next: CellGrid = { ...current };
        for (const [key, value] of Object.entries(imported)) {
          if (typeof value === 'string') {
            next[key] = value;
          }
        }
        return next;
      });
    } catch {
      // Keep the editor non-blocking on malformed CSV input.
    } finally {
      event.currentTarget.value = '';
    }
  };

  const addExpectedRow = () => {
    setExpectedRows((current) => [...current, { refId: '', label: '', value: '', sd: '' }]);
  };

  const removeExpectedRow = () => {
    setExpectedRows((current) => (current.length <= 1 ? current : current.slice(0, -1)));
  };

  const updateExpectedRow = (index: number, patch: Partial<ExpectedRefRow>) => {
    setExpectedRows((current) =>
      current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)),
    );
  };

  return (
    <section className={`results-panel plate-config-panel ${plateCellWidthClass}`} aria-labelledby="plate-map-heading">
      <div className="section-title-row">
        <h2 id="plate-map-heading">Plate Configurator</h2>
        <div className="button-row">
          <button type="button" className="secondary-button" onClick={onClear}>
            Clear map
          </button>
        </div>
      </div>

      <section className="nested-control-section" aria-labelledby="experiment-setup-heading">
        <h3 id="experiment-setup-heading">Experiment setup</h3>
        <div className="plate-config-setup-row">
          <label className="checkbox-control plate-config-extended-control">
            <input
              type="checkbox"
              checked={extendedView}
              onChange={(event) => setExtendedView(event.currentTarget.checked)}
            />
            <span>Extended view</span>
          </label>

          <label className="select-control plate-config-format-control">
            <span>Plate format</span>
            <select
              value={plateFormat}
              onChange={(event) =>
                handlePlateFormatChange(event.currentTarget.value as PlateFormatLabel)
              }
            >
              {(Object.keys(PLATE_FORMATS) as PlateFormatLabel[]).map((label) => (
                <option key={label} value={label}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <label className="select-control plate-config-unit-control">
            <span>Unit</span>
            <select
              value={unitBase}
              onChange={(event) => setUnitBase(event.currentTarget.value)}
            >
              <option value="M">M</option>
              <option value="mM">mM</option>
              <option value="uM">uM</option>
              <option value="nM">nM</option>
            </select>
          </label>

          {extendedView ? (
            <label className="select-control plate-config-exp-control">
              <span>x 10^</span>
              <input
                type="text"
                value={unitExp}
                onChange={(event) => setUnitExp(event.currentTarget.value)}
              />
            </label>
          ) : null}
          {extendedView ? (
            <fieldset className="plate-config-inline-radio-group">
              <legend>ID/DF priority</legend>
              <label className="radio-control">
                <input
                  type="radio"
                  name="idDfPriority"
                  checked={idDfPriority === 'row'}
                  onChange={() => setIdDfPriority('row')}
                />
                <span>Rows</span>
              </label>
              <label className="radio-control">
                <input
                  type="radio"
                  name="idDfPriority"
                  checked={idDfPriority === 'col'}
                  onChange={() => setIdDfPriority('col')}
                />
                <span>Columns</span>
              </label>
            </fieldset>
          ) : null}
          {onHelpRequest ? (
            <button
              type="button"
              className="secondary-button plate-config-help-button"
              onClick={onHelpRequest}
              aria-label="Open plate configurator help"
            >
              ?
            </button>
          ) : null}
        </div>
      </section>
{extendedView ? (
      <section className="nested-control-section" aria-labelledby="reference-values-heading">
        <h3 id="reference-values-heading">Reference values</h3>

        {expectedRows.map((row, index) => (
          <div className="plate-config-reference-row" key={`expected-${index}`}>
            <input
              type="text"
              aria-label={`Reference ${index + 1} ID`}
              placeholder="Ref ID"
              value={row.refId}
              onChange={(event) =>
                updateExpectedRow(index, { refId: event.currentTarget.value })
              }
            />
            <input
              type="text"
              aria-label={`Reference ${index + 1} label`}
              placeholder="Label"
              value={row.label}
              onChange={(event) =>
                updateExpectedRow(index, { label: event.currentTarget.value })
              }
            />
            <input
              type="text"
              aria-label={`Reference ${index + 1} value`}
              placeholder="Value"
              value={row.value}
              onChange={(event) =>
                updateExpectedRow(index, { value: event.currentTarget.value })
              }
            />
            <input
              type="text"
              aria-label={`Reference ${index + 1} SD`}
              placeholder="SD"
              value={row.sd}
              onChange={(event) =>
                updateExpectedRow(index, { sd: event.currentTarget.value })
              }
            />
            {index === expectedRows.length - 1 ? (
              <div className="plate-config-reference-actions">
                <button type="button" className="secondary-button plate-config-icon-button" onClick={addExpectedRow}>
                  +
                </button>
                <button
                  type="button"
                  className="secondary-button plate-config-icon-button"
                  onClick={removeExpectedRow}
                  disabled={expectedRows.length <= 1}
                >
                  -
                </button>
                <p className="panel-note plate-config-reference-count">Valid reference rows: {collectedExpectedRefs.length}</p>
                <button type="button" className="secondary-button" onClick={onStartNewAnalysis}>
                  RESET
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </section>
      ) : null}

      <section className={reviewContent ? "nested-control-section configurator-review-section" : workflowContent && configuratorMediaActive ? "nested-control-section configurator-workflow-section" : "nested-control-section"} aria-labelledby={reviewContent ? "configurator-review-heading" : workflowContent && configuratorMediaActive ? "configurator-workflow-heading" : "plate-map-editor-heading"}>
        <h3 id={reviewContent ? "configurator-review-heading" : workflowContent ? "configurator-workflow-heading" : "plate-map-editor-heading"}>{reviewContent ? 'Review the results' : workflowContent ? 'Image / Geometry' : 'Plate map editor'}</h3>

        {reviewContent ? (
          <div className="configurator-review-stage">
            {reviewContent}
          </div>
        ) : null}


        {workflowContent ? (
          <div className="configurator-workflow-actions-stage">
            {workflowContent}
          </div>
        ) : null}
<div className="button-row left-aligned-button-row plate-map-editor-actions">
          <button type="button" className="secondary-button" onClick={handleCopyRowA}>
            Copy row A
          </button>
          <button type="button" className="secondary-button" onClick={handleCopyCol1}>
            Copy col 1
          </button>
          {extendedView ? (
            <>
              <button
                type="button"
                className="secondary-button"
                onClick={handleExportCsvTemplate}
              >
                Export CSV template
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={handleImportCsvClick}
              >
                Import CSV
              </button>
            </>
          ) : null}
          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            accept=".csv,text/csv"
            onChange={handleImportCsv}
          />
        </div>

        <div className="plate-config-editor-summary">
          <p className="panel-note">Configured wells: {configuredWellCount}</p>
          <p className="panel-note">Empty cell = no data (0 is treated as a value).</p>
        </div>

        <div id="configurator-media-stage" className={configuratorMediaActive ? "configurator-media-stage configurator-media-stage-active" : "configurator-media-stage"}></div>
        <div className={configuratorMediaActive ? "plate-map-wrap plate-map-wrap-hidden" : "plate-map-wrap"}>
          <table className="plate-map-grid">
            <thead>
              <tr>
                <th>Row</th>
                {extendedView && idDfPriority === 'row' ? (
                  <>
                    <th>DF</th>
                    <th>ID</th>
                  </>
                ) : null}
                {extendedView ? <th>Type</th> : null}
                {Array.from({ length: ncol }, (_, col) => (
                  <th key={`header-col-${col}`}>{col + 1}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: nrow }, (_, row) => (
                <tr key={`row-${row}`}>
                  <th>{rowLabelFromIndex(row)}</th>
                  {extendedView && idDfPriority === 'row' ? (
                    <>
                      <td>
                        <input
                          className="plate-default-input plate-default-input-df"
                          type="text"
                          value={defaults.rowDf[row] ?? '1'}
                          onChange={(event) =>
                            setRowDefault(row, 'rowDf', event.currentTarget.value)
                          }
                        />
                      </td>
                      <td>
                        <input
                          className="plate-default-input plate-default-input-id"
                          type="text"
                          value={defaults.rowId[row] ?? rowLabelFromIndex(row)}
                          onChange={(event) =>
                            setRowDefault(row, 'rowId', event.currentTarget.value)
                          }
                        />
                      </td>
                    </>
                  ) : null}
                  {extendedView ? (
                    <td>
                      <div className="button-row left-aligned-button-row plate-tag-buttons">
                        <button
                          type="button"
                          className="secondary-button plate-tag-button"
                          onClick={() => handleTagRow(row, 'U')}
                        >
                          U
                        </button>
                        <button
                          type="button"
                          className="secondary-button plate-tag-button"
                          onClick={() => handleTagRow(row, 'C')}
                          disabled={storedCalibrationLoaded}
                        >
                          C
                        </button>
                        <button
                          type="button"
                          className="secondary-button plate-tag-button"
                          onClick={() => handleTagRow(row, 'A')}
                        >
                          A
                        </button>
                      </div>
                    </td>
                  ) : null}
                  {Array.from({ length: ncol }, (_, col) => {
                    const key = `${row}_${col}`;
                    const value = grid[key] ?? '';
                    const disabled = storedCalibrationLoaded && cellIsCType(value);

                    return (
                      <td key={`cell-${row}-${col}`}>
                        <input
                          className="plate-cell-input"
                          type="text"
                          value={value}
                          disabled={disabled}
                          onChange={(event) =>
                            setCell(row, col, event.currentTarget.value)
                          }
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}

              {extendedView && idDfPriority === 'col' ? (
                <>
                  <tr className="plate-col-default-row">
                    <th colSpan={2}>Col DF</th>
                    {Array.from({ length: ncol }, (_, col) => (
                      <td key={`col-df-${col}`}>
                        <input
                          className="plate-default-input plate-default-input-df"
                          type="text"
                          value={defaults.colDf[col] ?? ''}
                          onChange={(event) =>
                            setColDefault(col, 'colDf', event.currentTarget.value)
                          }
                        />
                      </td>
                    ))}
                  </tr>
                  <tr className="plate-col-default-row">
                    <th colSpan={2}>Col ID</th>
                    {Array.from({ length: ncol }, (_, col) => (
                      <td key={`col-id-${col}`}>
                        <input
                          className="plate-default-input plate-default-input-id"
                          type="text"
                          value={defaults.colId[col] ?? String(col + 1)}
                          onChange={(event) =>
                            setColDefault(col, 'colId', event.currentTarget.value)
                          }
                        />
                      </td>
                    ))}
                  </tr>
                </>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

    </section>
  );
}
