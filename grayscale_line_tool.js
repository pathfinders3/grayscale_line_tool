"use strict";

// ---------- Element refs ----------
const originalCanvas = document.getElementById('originalCanvas');
const originalCtx = originalCanvas.getContext('2d');
const graphCanvas = document.getElementById('graphCanvas');
const yInput = document.getElementById('yInput');
const lineCountInput = document.getElementById('lineCountInput');
const statusEl = document.getElementById('status');
const peakValuesPanelEl = document.getElementById('peakValuesPanel');
const peakSidesPanelEl = document.getElementById('peakSidesPanel');
const originalHoverInfoEl = document.getElementById('originalHoverInfo');
const graphHoverInfoEl = document.getElementById('graphHoverInfo');
const peakModeSelect = document.getElementById('peakModeSelect');
const plateauToleranceInput = document.getElementById('plateauToleranceInput');
const reboundModeSelect = document.getElementById('reboundModeSelect');
const reboundDeltaInput = document.getElementById('reboundDeltaInput');

// ---------- State ----------
// sourceCanvas holds the PURE, untouched pixel data of the pasted image.
// It is never drawn with the selection overlay, so it can always be
// used as the single source of truth for sampling (requirement #3).
let sourceCanvas = null;
let sourceCtx = null;
let hasImage = false;

// Selection is expressed in native image-pixel coordinates.
let selection = null; // { xMin, xMax, yTop, yBottom }
let isDragging = false;
let dragStartX = 0, dragStartY = 0;

// Last snapshot kept in memory (also logged to console).
let currentSnapshot = null;
let selectedCumulateLine = 'all';
let analysisOptions = {
  peakMode: 'strict',
  plateauTolerance: 0,
  reboundMode: 'first-rise',
  reboundDelta: 1
};
let hoverGuideState = {
  active: false,
  sampleIndex: -1,
  canvasX: 0
};
let originalGuideLineY = null;
let originalGuideLineX = null;
let originalGuideLineYTimer = null;
let originalGuideLineXTimer = null;

function parseNonNegativeInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) return fallback;
  return n;
}

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 1) return fallback;
  return n;
}

function getAnalysisOptionsFromInputs() {
  const peakMode = peakModeSelect && (peakModeSelect.value === 'plateau' || peakModeSelect.value === 'strict')
    ? peakModeSelect.value
    : 'strict';
  const reboundMode = reboundModeSelect && (reboundModeSelect.value === 'delta-rise' || reboundModeSelect.value === 'first-rise')
    ? reboundModeSelect.value
    : 'first-rise';
  const plateauTolerance = plateauToleranceInput ? parseNonNegativeInt(plateauToleranceInput.value, 0) : 0;
  const reboundDelta = reboundDeltaInput ? parsePositiveInt(reboundDeltaInput.value, 1) : 1;

  return {
    peakMode,
    plateauTolerance,
    reboundMode,
    reboundDelta
  };
}

function syncAnalysisOptionsFromInputs() {
  analysisOptions = getAnalysisOptionsFromInputs();
  if (reboundDeltaInput) {
    reboundDeltaInput.disabled = analysisOptions.reboundMode !== 'delta-rise';
  }
}

function setPanelText(el, text) {
  if (!el) return;
  el.textContent = text || '데이터 없음';
}

function togglePeakPanel(panelId, buttonId) {
  const panel = document.getElementById(panelId);
  const button = document.getElementById(buttonId);
  if (!panel || !button) return;

  const currentDisplay = window.getComputedStyle(panel).display;
  const isOpen = currentDisplay !== 'none';
  panel.style.display = isOpen ? 'none' : 'block';

  const title = button.dataset.title || button.textContent.replace(/\s[▼▲]$/, '');
  button.textContent = `${title} ${isOpen ? '▼' : '▲'}`;
}

function findPeaks(values, options = {}) {
  if (!Array.isArray(values) || values.length < 3) return [];

  const peakMode = options.peakMode === 'plateau' ? 'plateau' : 'strict';
  const tolerance = parseNonNegativeInt(options.plateauTolerance, 0);

  if (peakMode === 'strict') {
    const peaks = [];
    for (let i = 1; i < values.length - 1; i++) {
      const left = values[i - 1];
      const current = values[i];
      const right = values[i + 1];
      if (current - left > tolerance && current - right > tolerance) {
        peaks.push(i);
      }
    }
    return peaks;
  }

  const peaks = [];
  let i = 1;
  while (i < values.length - 1) {
    const start = i;
    let end = i;
    while (end + 1 < values.length && Math.abs(values[end + 1] - values[start]) <= tolerance) {
      end += 1;
    }

    if (start > 0 && end < values.length - 1) {
      const top = values[start];
      const left = values[start - 1];
      const right = values[end + 1];
      if (top - left > tolerance && top - right > tolerance) {
        peaks.push(Math.floor((start + end) / 2));
      }
    }
    i = end + 1;
  }

  return peaks;
}

function analyzePeakSides(values, peakIndices, options = {}) {
  if (!Array.isArray(values) || !Array.isArray(peakIndices) || peakIndices.length === 0) return [];

  const reboundMode = options.reboundMode === 'delta-rise' ? 'delta-rise' : 'first-rise';
  const reboundDelta = parsePositiveInt(options.reboundDelta, 1);

  const results = [];
  for (const peakIndex of peakIndices) {
    if (typeof peakIndex !== 'number' || peakIndex < 0 || peakIndex >= values.length) continue;

    let leftReboundIndex = -1;
    for (let i = peakIndex - 1; i >= 1; i--) {
      const rises = values[i - 1] > values[i];
      const risesByDelta = values[i - 1] >= values[i] + reboundDelta;
      if ((reboundMode === 'first-rise' && rises) || (reboundMode === 'delta-rise' && risesByDelta)) {
        leftReboundIndex = i;
        break;
      }
    }

    let rightReboundIndex = -1;
    for (let i = peakIndex + 1; i <= values.length - 2; i++) {
      const rises = values[i + 1] > values[i];
      const risesByDelta = values[i + 1] >= values[i] + reboundDelta;
      if ((reboundMode === 'first-rise' && rises) || (reboundMode === 'delta-rise' && risesByDelta)) {
        rightReboundIndex = i;
        break;
      }
    }

    results.push({
      peakIndex,
      peakValue: values[peakIndex],
      leftReboundIndex,
      rightReboundIndex,
      leftDistance: leftReboundIndex >= 0 ? peakIndex - leftReboundIndex : -1,
      rightDistance: rightReboundIndex >= 0 ? rightReboundIndex - peakIndex : -1
    });
  }

  return results;
}

function formatPeakValuesForDisplay(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return '데이터 없음';

  const rows = [];
  rows.push(`mode=${analysisOptions.peakMode}, tolerance=${analysisOptions.plateauTolerance}`);
  for (const line of lines) {
    const values = Array.isArray(line.peakValues) ? line.peakValues : [];
    const label = line.label || 'L?';
    rows.push(`${label}: [${values.join(', ')}]`);
  }

  return rows.length > 0 ? rows.join('\n') : '데이터 없음';
}

function formatPeakSidesForDisplay(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return '데이터 없음';

  const out = [];
  out.push(`mode=${analysisOptions.reboundMode}, delta=${analysisOptions.reboundDelta}`);
  for (const line of lines) {
    out.push(`${line.label || 'L?'}`);
    const sides = Array.isArray(line.sides) ? line.sides : [];
    if (sides.length === 0) {
      out.push('-');
      continue;
    }
    for (const item of sides) {
      out.push(
        `peakIndex=${item.peakIndex}, peakValue=${item.peakValue}, leftReboundIndex=${item.leftReboundIndex}, rightReboundIndex=${item.rightReboundIndex}, leftDistance=${item.leftDistance}, rightDistance=${item.rightDistance}`
      );
    }
  }

  return out.join('\n');
}

function getActiveLinesFromGraphState() {
  if (!currentSnapshot || typeof currentSnapshot !== 'object') return [];

  if (currentSnapshot.type === 'grayscale-line') {
    if (!Array.isArray(currentSnapshot.values) || currentSnapshot.values.length === 0) return [];
    return [{ label: 'L1', values: currentSnapshot.values }];
  }

  if (currentSnapshot.type === 'cumulate-lines') {
    if (!Array.isArray(currentSnapshot.lines) || currentSnapshot.lines.length === 0) return [];

    if (selectedCumulateLine === 'all') {
      return currentSnapshot.lines.map((line, index) => ({
        label: `L${index + 1}`,
        values: Array.isArray(line.values) ? line.values : []
      }));
    }

    const target = Number(selectedCumulateLine);
    if (!Number.isInteger(target) || target < 0 || target >= currentSnapshot.lines.length) return [];
    const line = currentSnapshot.lines[target];
    return [{ label: `L${target + 1}`, values: Array.isArray(line.values) ? line.values : [] }];
  }

  return [];
}

function getGraphCanvasCoords(evt) {
  const rect = graphCanvas.getBoundingClientRect();
  const scaleX = graphCanvas.width / rect.width;
  const scaleY = graphCanvas.height / rect.height;
  return {
    x: Math.max(0, Math.min(graphCanvas.width - 1, Math.round((evt.clientX - rect.left) * scaleX))),
    y: Math.max(0, Math.min(graphCanvas.height - 1, Math.round((evt.clientY - rect.top) * scaleY)))
  };
}

function getSampleIndexFromCanvasX(canvasX, sampleCount) {
  const left = 30;
  const right = graphCanvas.width - 10;
  if (sampleCount <= 0 || canvasX < left || canvasX > right) return -1;
  const indexRatio = (canvasX - left) / Math.max(1, right - left);
  return Math.max(0, Math.min(sampleCount - 1, Math.round(indexRatio * (sampleCount - 1))));
}

function getOriginalXFromGraphSampleIndex(sampleIndex, sampleCount, xMin, xMax) {
  if (!Number.isInteger(sampleIndex) || sampleIndex < 0 || sampleCount <= 0) return null;
  const start = Number.isFinite(xMin) ? xMin : 0;
  const end = Number.isFinite(xMax) ? xMax : start;
  const span = Math.max(0, end - start);
  const ratio = sampleCount > 1 ? sampleIndex / (sampleCount - 1) : 0;
  const mappedX = Math.max(0, Math.min(sourceCanvas ? sourceCanvas.width - 1 : end, Math.round(start + ratio * span)));
  return mappedX;
}

function drawGraphHoverGuide() {
  if (!hoverGuideState.active) return;

  const ctx = graphCanvas.getContext('2d');
  const left = 30;
  const right = graphCanvas.width - 10;
  const top = 10;
  const bottom = graphCanvas.height - 30;
  const x = Math.max(left, Math.min(right, hoverGuideState.canvasX));

  ctx.save();
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = 'rgba(255,255,255,0.72)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.lineTo(x, bottom);
  ctx.stroke();
  ctx.setLineDash([]);

  const label = `idx ${hoverGuideState.sampleIndex}`;
  ctx.font = '11px sans-serif';
  const textWidth = ctx.measureText(label).width;
  const boxX = Math.max(left, Math.min(right - textWidth - 10, x + 5));
  const boxY = top + 4;
  ctx.fillStyle = 'rgba(20,20,20,0.88)';
  ctx.fillRect(boxX, boxY, textWidth + 8, 14);
  ctx.fillStyle = '#e8e8e8';
  ctx.fillText(label, boxX + 4, boxY + 11);
  ctx.restore();
}

function renderCurrentGraphWithHoverGuide() {
  if (!currentSnapshot || typeof currentSnapshot !== 'object') {
    const ctx = graphCanvas.getContext('2d');
    ctx.clearRect(0, 0, graphCanvas.width, graphCanvas.height);
    return;
  }

  if (currentSnapshot.type === 'grayscale-line') {
    drawSingleGrayscaleGraph(graphCanvas, currentSnapshot);
  } else if (currentSnapshot.type === 'cumulate-lines') {
    drawCumulatedGrayscaleGraph(graphCanvas, currentSnapshot, selectedCumulateLine);
  }

  drawGraphHoverGuide();
}

function setGraphHoverInfo(text) {
  if (!graphHoverInfoEl) return;
  graphHoverInfoEl.textContent = text;
}

function setOriginalHoverInfo(text) {
  if (!originalHoverInfoEl) return;
  originalHoverInfoEl.textContent = text;
}

function showTemporaryOriginalGuideLine(y, durationMs = 15000) {
  if (!hasImage || !sourceCanvas) return;
  const clampedY = Math.max(0, Math.min(sourceCanvas.height - 1, Math.round(y)));
  originalGuideLineY = clampedY;
  if (originalGuideLineYTimer) {
    clearTimeout(originalGuideLineYTimer);
    originalGuideLineYTimer = null;
  }
  redrawOriginalCanvas();
  originalGuideLineYTimer = setTimeout(() => {
    originalGuideLineY = null;
    originalGuideLineYTimer = null;
    redrawOriginalCanvas();
  }, durationMs);
}

function showTemporaryOriginalVerticalGuideLine(x, durationMs = 15000) {
  if (!hasImage || !sourceCanvas) return;
  const clampedX = Math.max(0, Math.min(sourceCanvas.width - 1, Math.round(x)));
  originalGuideLineX = clampedX;
  if (originalGuideLineXTimer) {
    clearTimeout(originalGuideLineXTimer);
    originalGuideLineXTimer = null;
  }
  redrawOriginalCanvas();
  originalGuideLineXTimer = setTimeout(() => {
    originalGuideLineX = null;
    originalGuideLineXTimer = null;
    redrawOriginalCanvas();
  }, durationMs);
}

function updateGraphHoverInfo(evt) {
  if (!evt) return;
  const lines = getActiveLinesFromGraphState();
  if (!lines || lines.length === 0) {
    hoverGuideState.active = false;
    renderCurrentGraphWithHoverGuide();
    setGraphHoverInfo('graph cursor: x=-, y=-, color=데이터 없음');
    return;
  }

  const coords = getGraphCanvasCoords(evt);
  const sampleCount = Array.isArray(lines[0].values) ? lines[0].values.length : 0;
  const sampleIndex = getSampleIndexFromCanvasX(coords.x, sampleCount);
  if (sampleIndex < 0) {
    hoverGuideState.active = false;
    renderCurrentGraphWithHoverGuide();
    setGraphHoverInfo(`graph cursor: x=${coords.x}, y=${coords.y}, color=-`);
    return;
  }

  if (sampleCount <= 0) {
    hoverGuideState.active = false;
    renderCurrentGraphWithHoverGuide();
    setGraphHoverInfo(`graph cursor: x=${coords.x}, y=${coords.y}, color=데이터 없음`);
    return;
  }

  const left = 30;
  const right = graphCanvas.width - 10;
  const sampleX = left + (sampleIndex / Math.max(1, sampleCount - 1)) * (right - left);
  hoverGuideState.active = true;
  hoverGuideState.sampleIndex = sampleIndex;
  hoverGuideState.canvasX = sampleX;

  const mappedX = currentSnapshot && Number.isFinite(currentSnapshot.graphXMin) && Number.isFinite(currentSnapshot.graphXMax)
    ? getOriginalXFromGraphSampleIndex(sampleIndex, sampleCount, currentSnapshot.graphXMin, currentSnapshot.graphXMax)
    : null;

  const parts = [];
  for (const line of lines) {
    if (!Array.isArray(line.values) || sampleIndex >= line.values.length) continue;
    const v = line.values[sampleIndex];
    parts.push(`${line.label}:${v}`);
  }

  const colorText = parts.length > 0 ? parts.join(', ') : '데이터 없음';
  renderCurrentGraphWithHoverGuide();
  setGraphHoverInfo(`graph cursor: x=${mappedX ?? coords.x}, y=${coords.y}, sampleIndex=${sampleIndex}, color=${colorText}`);
}

function updatePeakPanelsFromCurrentGraphState() {
  syncAnalysisOptionsFromInputs();
  const lines = getActiveLinesFromGraphState();
  if (!lines || lines.length === 0) {
    setPanelText(peakValuesPanelEl, '데이터 없음');
    setPanelText(peakSidesPanelEl, '데이터 없음');
    return;
  }

  const analyzed = lines.map((line) => {
    const values = Array.isArray(line.values) ? line.values : [];
    const peakIndices = findPeaks(values, analysisOptions);
    const sides = analyzePeakSides(values, peakIndices, analysisOptions);
    return {
      label: line.label,
      peakIndices,
      peakValues: peakIndices.map((idx) => values[idx]),
      sides
    };
  });

  setPanelText(peakValuesPanelEl, formatPeakValuesForDisplay(analyzed));
  setPanelText(peakSidesPanelEl, formatPeakSidesForDisplay(analyzed));
}

// ---------- Status helper ----------
function setStatus(msg, isError) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', !!isError);
}

// ---------- Paste image handling ----------
document.addEventListener('paste', async (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.type && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (!file) continue;
      try {
        const bitmap = await createImageBitmap(file);
        loadImageIntoCanvases(bitmap);
      } catch (err) {
        setStatus('이미지를 불러오지 못했습니다: ' + err.message, true);
      }
      e.preventDefault();
      return;
    }
  }
});

function createDefaultSelection(width, height) {
  const xPad = Math.max(8, Math.round(width * 0.1));
  const yPad = Math.max(8, Math.round(height * 0.15));
  const xMin = Math.min(width - 1, Math.max(0, xPad));
  const xMax = Math.max(xMin + 1, width - xPad - 1);
  const yTop = Math.min(height - 1, Math.max(0, yPad));
  const yBottom = Math.max(yTop + 1, height - yPad - 1);

  return {
    xMin,
    xMax,
    yTop,
    yBottom
  };
}

function loadImageIntoCanvases(bitmap) {
  // Rebuild the pure source canvas at native image resolution.
  sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = bitmap.width;
  sourceCanvas.height = bitmap.height;
  sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  sourceCtx.drawImage(bitmap, 0, 0);

  originalCanvas.width = bitmap.width;
  originalCanvas.height = bitmap.height;
  hasImage = true;
  if (originalGuideLineYTimer) {
    clearTimeout(originalGuideLineYTimer);
    originalGuideLineYTimer = null;
  }
  if (originalGuideLineXTimer) {
    clearTimeout(originalGuideLineXTimer);
    originalGuideLineXTimer = null;
  }
  originalGuideLineY = null;
  originalGuideLineX = null;
  selection = createDefaultSelection(bitmap.width, bitmap.height);
  const midY = Math.round((selection.yTop + selection.yBottom) / 2);
  yInput.value = midY;
  redrawOriginalCanvas();

  try {
    const values = getGrayscaleSamplesFromFixedY(sourceCtx, selection.xMin, selection.xMax, midY, sourceCanvas.width, sourceCanvas.height);
    currentSnapshot = buildGrayscaleSnapshot(midY, selection.xMin, selection.xMax, values);
    drawSingleGrayscaleGraph(graphCanvas, currentSnapshot);
    updatePeakPanelsFromCurrentGraphState();
    setStatus(`이미지 로드 완료 (${bitmap.width} x ${bitmap.height}). 기본 선택 영역이 자동 적용되었습니다. 드래그로 직접 영역을 바꿀 수 있습니다.`);
  } catch (err) {
    updatePeakPanelsFromCurrentGraphState();
    setStatus(`이미지 로드 완료 (${bitmap.width} x ${bitmap.height}). 기본 선택 영역을 적용했지만 그래프 생성 중 오류가 발생했습니다: ${err.message}`, true);
  }
}

// Redraws the visible canvas from the pure source + a selection overlay.
// The overlay is drawn on top of a fresh copy of the source image every
// time, so it never contaminates the pixel data used for sampling.
function redrawOriginalCanvas() {
  if (!hasImage) return;
  originalCtx.clearRect(0, 0, originalCanvas.width, originalCanvas.height);
  originalCtx.drawImage(sourceCanvas, 0, 0);
  if (selection) {
    originalCtx.save();
    originalCtx.strokeStyle = 'rgba(255,0,0,0.9)';
    originalCtx.lineWidth = 1;
    originalCtx.fillStyle = 'rgba(255,0,0,0.15)';
    const w = selection.xMax - selection.xMin;
    const h = selection.yBottom - selection.yTop;
    originalCtx.fillRect(selection.xMin, selection.yTop, w, h);
    originalCtx.strokeRect(selection.xMin, selection.yTop, w, h);
    originalCtx.restore();
  }

  if (typeof originalGuideLineY === 'number') {
    originalCtx.save();
    originalCtx.strokeStyle = 'rgba(0, 199, 0, 0.95)';
    originalCtx.lineWidth = 1.5;
    originalCtx.setLineDash([7, 5]);
    originalCtx.beginPath();
    originalCtx.moveTo(0, originalGuideLineY + 0.5);
    originalCtx.lineTo(originalCanvas.width, originalGuideLineY + 0.5);
    originalCtx.stroke();
    originalCtx.setLineDash([]);
    originalCtx.fillStyle = 'rgba(0, 0, 0, 0.72)';
    originalCtx.fillRect(4, Math.max(2, originalGuideLineY - 15), 42, 13);
    originalCtx.fillStyle = '#7ef3ff';
    originalCtx.font = '11px sans-serif';
    originalCtx.fillText(`y=${originalGuideLineY}`, 8, Math.max(12, originalGuideLineY - 5));
    originalCtx.restore();
  }

  if (typeof originalGuideLineX === 'number') {
    originalCtx.save();
    originalCtx.strokeStyle = 'rgba(0, 180, 255, 0.95)';
    originalCtx.lineWidth = 1.5;
    originalCtx.setLineDash([7, 5]);
    originalCtx.beginPath();
    originalCtx.moveTo(originalGuideLineX + 0.5, 0);
    originalCtx.lineTo(originalGuideLineX + 0.5, originalCanvas.height);
    originalCtx.stroke();
    originalCtx.setLineDash([]);
    originalCtx.fillStyle = 'rgba(0, 0, 0, 0.72)';
    originalCtx.fillRect(Math.max(4, originalGuideLineX - 20), 4, 46, 13);
    originalCtx.fillStyle = '#7ef3ff';
    originalCtx.font = '11px sans-serif';
    originalCtx.fillText(`x=${originalGuideLineX}`, Math.max(8, originalGuideLineX - 16), 15);
    originalCtx.restore();
  }
}

function moveSelectionBy(dx, dy) {
  if (!hasImage || !selection) return;
  const width = Math.max(1, selection.xMax - selection.xMin);
  const height = Math.max(1, selection.yBottom - selection.yTop);

  const maxX = Math.max(0, originalCanvas.width - width);
  const maxY = Math.max(0, originalCanvas.height - height);

  selection.xMin = Math.max(0, Math.min(maxX, selection.xMin + dx));
  selection.xMax = selection.xMin + width;
  selection.yTop = Math.max(0, Math.min(maxY, selection.yTop + dy));
  selection.yBottom = selection.yTop + height;

  const midY = Math.round((selection.yTop + selection.yBottom) / 2);
  yInput.value = midY;
  redrawOriginalCanvas();

  if (currentSnapshot && currentSnapshot.type === 'grayscale-line') {
    const values = getGrayscaleSamplesFromFixedY(sourceCtx, selection.xMin, selection.xMax, midY, sourceCanvas.width, sourceCanvas.height);
    currentSnapshot = buildGrayscaleSnapshot(midY, selection.xMin, selection.xMax, values);
    drawSingleGrayscaleGraph(graphCanvas, currentSnapshot);
  } else if (currentSnapshot && currentSnapshot.type === 'cumulate-lines') {
    const baseY = midY;
    const lineCount = currentSnapshot.lineCount;
    const xMin = selection.xMin;
    const xMax = selection.xMax;
    const lines = [];
    for (let i = 0; i < lineCount; i++) {
      const y = baseY - i;
      if (y < 0) break;
      const values = getGrayscaleSamplesFromFixedY(sourceCtx, xMin, xMax, y, sourceCanvas.width, sourceCanvas.height);
      lines.push({ y, label: `y=${y}`, color: colorForIndex(i, lineCount), values });
    }
    if (lines.length > 0) {
      currentSnapshot = buildCumulateSnapshot(baseY, lines.length, xMin, xMax, lines);
      renderCumulateSelector(currentSnapshot);
      drawCumulatedGrayscaleGraph(graphCanvas, currentSnapshot, selectedCumulateLine);
    }
  }

  updatePeakPanelsFromCurrentGraphState();

  setStatus(`선택 영역 이동: X[${selection.xMin}, ${selection.xMax}], Y 중앙=${midY}`);
}

// Converts a mouse event to native canvas-pixel coordinates, accounting
// for any CSS scaling of the displayed canvas.
function getCanvasCoords(evt) {
  const rect = originalCanvas.getBoundingClientRect();
  const scaleX = originalCanvas.width / rect.width;
  const scaleY = originalCanvas.height / rect.height;
  return {
    x: Math.round((evt.clientX - rect.left) * scaleX),
    y: Math.round((evt.clientY - rect.top) * scaleY)
  };
}

originalCanvas.addEventListener('mousedown', (e) => {
  if (!hasImage) return;
  const { x, y } = getCanvasCoords(e);
  isDragging = true;
  dragStartX = x;
  dragStartY = y;
  selection = { xMin: x, xMax: x, yTop: y, yBottom: y };
  redrawOriginalCanvas();
});

originalCanvas.addEventListener('mousemove', (e) => {
  const { x, y } = getCanvasCoords(e);
  setOriginalHoverInfo(`original cursor: x=${x}, y=${y}`);

  if (!isDragging || !hasImage) return;
  selection.xMin = Math.max(0, Math.min(dragStartX, x));
  selection.xMax = Math.min(originalCanvas.width - 1, Math.max(dragStartX, x));
  selection.yTop = Math.max(0, Math.min(dragStartY, y));
  selection.yBottom = Math.min(originalCanvas.height - 1, Math.max(dragStartY, y));
  redrawOriginalCanvas();
});

originalCanvas.addEventListener('mouseleave', () => {
  setOriginalHoverInfo('original cursor: x=-, y=-');
});

window.addEventListener('mouseup', () => {
  if (!isDragging) return;
  isDragging = false;
  if (selection) {
    const midY = Math.round((selection.yTop + selection.yBottom) / 2);
    yInput.value = midY;
    setStatus(`선택 영역: X[${selection.xMin}, ${selection.xMax}], Y 중앙=${midY}`);
  }
});

window.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  if (['w', 'a', 's', 'd'].includes(key) === false) return;
  if (event.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;

  event.preventDefault();
  if (!hasImage || !selection) return;

  const dx = key === 'd' ? 5 : key === 'a' ? -5 : 0;
  const dy = key === 's' ? 5 : key === 'w' ? -5 : 0;
  moveSelectionBy(dx, dy);
});

// ---------- Sampling ----------
// Reads 64 grayscale samples along row `fixedY`.
// Sampling strategy chosen: EVEN SPACING across [xMin, xMax] (not 64
// raw consecutive pixels), so the graph always spans the full selected
// (or full-image) X range regardless of how many pixels wide it is.
function getGrayscaleSamplesFromFixedY(ctx, xMin, xMax, fixedY, canvasWidth, canvasHeight) {
  if (!ctx) throw new Error('소스 캔버스가 없습니다.');
  const y = Math.max(0, Math.min(canvasHeight - 1, Math.round(fixedY)));
  let x0 = Math.max(0, Math.min(canvasWidth - 1, Math.round(xMin)));
  let x1 = Math.max(0, Math.min(canvasWidth - 1, Math.round(xMax)));
  if (x1 < x0) { const t = x0; x0 = x1; x1 = t; }
  const span = Math.max(1, x1 - x0);
  const values = [];
  for (let i = 0; i < 64; i++) {
    const t = i / 63;
    const x = Math.max(0, Math.min(canvasWidth - 1, Math.round(x0 + t * span)));
    const pixel = ctx.getImageData(x, y, 1, 1).data;
    const gray = Math.round(0.299 * pixel[0] + 0.587 * pixel[1] + 0.114 * pixel[2]);
    values.push(gray);
  }
  return values;
}

// ---------- Snapshot builders ----------
function buildGrayscaleSnapshot(fixedY, xMin, xMax, values) {
  return {
    type: 'grayscale-line',
    version: 1,
    fixedY,
    graphXMin: xMin,
    graphXMax: xMax,
    values,
    yMin: 0,
    yMax: 255,
    capturedAt: new Date().toISOString()
  };
}

function buildCumulateSnapshot(baseY, lineCount, xMin, xMax, lines) {
  return {
    type: 'cumulate-lines',
    version: 1,
    baseY,
    fixedY: baseY,
    lineCount,
    graphXMin: xMin,
    graphXMax: xMax,
    lines,
    yMin: 0,
    yMax: 255,
    capturedAt: new Date().toISOString()
  };
}

function colorForIndex(i, total) {
  const hue = Math.round((360 * i) / Math.max(1, total));
  return `hsl(${hue}, 80%, 60%)`;
}

// ---------- Rendering ----------
function drawAxes(ctx, canvas) {
  ctx.save();
  ctx.strokeStyle = '#444';
  ctx.lineWidth = 1;
  ctx.strokeRect(30, 10, canvas.width - 40, canvas.height - 40);
  ctx.restore();
}

function plotLine(ctx, canvas, values, yMin, yMax, color) {
  const left = 30, right = canvas.width - 10, top = 10, bottom = canvas.height - 30;
  const w = right - left, h = bottom - top;
  const range = (yMax - yMin) || 1;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = left + (i / (values.length - 1 || 1)) * w;
    const norm = (v - yMin) / range;
    const y = bottom - norm * h;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.restore();
}

function renderCumulateSelector(snapshot) {
  const container = document.getElementById('cumulateOptions');
  if (!container) return;

  if (!snapshot || snapshot.type !== 'cumulate-lines' || !Array.isArray(snapshot.lines) || snapshot.lines.length === 0) {
    container.style.display = 'none';
    container.innerHTML = '';
    selectedCumulateLine = 'all';
    return;
  }

  const selectedIndex = Number(selectedCumulateLine);
  if (selectedCumulateLine !== 'all' && (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= snapshot.lines.length)) {
    selectedCumulateLine = 'all';
  }

  container.innerHTML = '';
  const allLabel = document.createElement('label');
  const allInput = document.createElement('input');
  allInput.type = 'radio';
  allInput.name = 'cumulateLineSelection';
  allInput.value = 'all';
  allInput.checked = selectedCumulateLine === 'all';
  allInput.addEventListener('change', () => {
    if (!allInput.checked) return;
    selectedCumulateLine = 'all';
    drawCumulatedGrayscaleGraph(graphCanvas, currentSnapshot, selectedCumulateLine);
    if (Array.isArray(currentSnapshot.lines) && currentSnapshot.lines.length > 0) {
      showTemporaryOriginalGuideLine(currentSnapshot.lines[0].y, 15000);
    }
    updatePeakPanelsFromCurrentGraphState();
    setStatus(`cumulate 표시: 전체 라인 (${currentSnapshot.lines.length}개)`);
  });
  allLabel.appendChild(allInput);
  allLabel.appendChild(document.createTextNode('all'));
  container.appendChild(allLabel);

  snapshot.lines.forEach((line, index) => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'cumulateLineSelection';
    input.value = String(index);
    input.checked = String(selectedCumulateLine) === String(index);
    input.addEventListener('change', () => {
      if (!input.checked) return;
      selectedCumulateLine = String(index);
      drawCumulatedGrayscaleGraph(graphCanvas, currentSnapshot, selectedCumulateLine);
      showTemporaryOriginalGuideLine(line.y, 15000);
      updatePeakPanelsFromCurrentGraphState();
      setStatus(`cumulate 표시: line ${index + 1} (${line.label || `y=${line.y}`})`);
    });

    label.appendChild(input);
    label.appendChild(document.createTextNode(`line ${index + 1} (y=${line.y})`));
    container.appendChild(label);
  });

  container.style.display = 'flex';
}

function drawSingleGrayscaleGraph(canvas, snapshot) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const selector = document.getElementById('cumulateOptions');
  if (selector) {
    selector.style.display = 'none';
    selector.innerHTML = '';
  }
  selectedCumulateLine = 'all';
  if (!snapshot || !Array.isArray(snapshot.values) || snapshot.values.length === 0) {
    setStatus('그릴 데이터가 없습니다.', true);
    return;
  }
  drawAxes(ctx, canvas);
  plotLine(ctx, canvas, snapshot.values, snapshot.yMin, snapshot.yMax, '#4da6ff');
}

function drawCumulatedGrayscaleGraph(canvas, snapshot, selectedLine = selectedCumulateLine) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!snapshot || !Array.isArray(snapshot.lines) || snapshot.lines.length === 0) {
    setStatus('그릴 데이터가 없습니다.', true);
    return;
  }
  drawAxes(ctx, canvas);

  const targetIndex = selectedLine === 'all' ? null : Number(selectedLine);
  const linesToDraw = snapshot.lines.filter((line, index) => targetIndex === null || index === targetIndex);

  if (linesToDraw.length === 0) {
    setStatus('선택된 누적 라인이 없습니다.', true);
    return;
  }

  for (const line of linesToDraw) {
    if (Array.isArray(line.values) && line.values.length > 0) {
      plotLine(ctx, canvas, line.values, snapshot.yMin, snapshot.yMax, line.color || '#4da6ff');
    }
  }
}

// ---------- Restore from JSON ----------
function restoreGraphFromJson(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    setStatus('JSON 파싱 실패: 올바른 JSON이 아닙니다.', true);
    return;
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.type) {
    setStatus('JSON 형식 오류: type 필드가 없습니다.', true);
    return;
  }

  if (parsed.type === 'grayscale-line') {
    if (!Array.isArray(parsed.values) || parsed.values.length === 0) {
      setStatus('grayscale-line JSON 오류: values 필드가 없거나 비어 있습니다.', true);
      return;
    }
    const snapshot = {
      type: 'grayscale-line',
      version: parsed.version || 1,
      fixedY: parsed.fixedY,
      graphXMin: parsed.graphXMin,
      graphXMax: parsed.graphXMax,
      values: parsed.values,
      yMin: typeof parsed.yMin === 'number' ? parsed.yMin : 0,
      yMax: typeof parsed.yMax === 'number' ? parsed.yMax : 255,
      capturedAt: parsed.capturedAt
    };
    currentSnapshot = snapshot;
    drawSingleGrayscaleGraph(graphCanvas, snapshot);
    updatePeakPanelsFromCurrentGraphState();
    setStatus(`grayscale-line 복원 완료 (fixedY=${snapshot.fixedY}, 샘플 ${snapshot.values.length}개)`);
  } else if (parsed.type === 'cumulate-lines') {
    if (!Array.isArray(parsed.lines) || parsed.lines.length === 0) {
      setStatus('cumulate-lines JSON 오류: lines 필드가 없거나 비어 있습니다.', true);
      return;
    }
    for (const line of parsed.lines) {
      if (!line || !Array.isArray(line.values)) {
        setStatus('cumulate-lines JSON 오류: 각 라인에 values 배열이 필요합니다.', true);
        return;
      }
    }
    const snapshot = {
      type: 'cumulate-lines',
      version: parsed.version || 1,
      baseY: parsed.baseY,
      fixedY: parsed.fixedY,
      lineCount: parsed.lineCount || parsed.lines.length,
      graphXMin: parsed.graphXMin,
      graphXMax: parsed.graphXMax,
      lines: parsed.lines.map((l, i) => ({
        y: l.y,
        label: l.label || `line${i}`,
        color: l.color || colorForIndex(i, parsed.lines.length),
        values: l.values
      })),
      yMin: typeof parsed.yMin === 'number' ? parsed.yMin : 0,
      yMax: typeof parsed.yMax === 'number' ? parsed.yMax : 255,
      capturedAt: parsed.capturedAt
    };
    currentSnapshot = snapshot;
    selectedCumulateLine = 'all';
    renderCumulateSelector(snapshot);
    drawCumulatedGrayscaleGraph(graphCanvas, snapshot, selectedCumulateLine);
    updatePeakPanelsFromCurrentGraphState();
    setStatus(`cumulate-lines 복원 완료 (라인 ${snapshot.lines.length}개)`);
  } else {
    setStatus(`알 수 없는 type 값입니다: ${parsed.type}`, true);
  }
}

// ---------- Button handlers ----------
document.getElementById('btnGrayscale').addEventListener('click', () => {
  try {
    if (!hasImage) { setStatus('먼저 캔버스에 이미지를 붙여넣어 주세요 (Ctrl+V).', true); return; }
    const fixedY = parseInt(yInput.value, 10);
    if (isNaN(fixedY) || fixedY < 0) { setStatus('Y 값을 확인해 주세요 (0 이상의 숫자).', true); return; }
    const xMin = selection ? selection.xMin : 0;
    const xMax = selection ? selection.xMax : sourceCanvas.width - 1;
    const values = getGrayscaleSamplesFromFixedY(sourceCtx, xMin, xMax, fixedY, sourceCanvas.width, sourceCanvas.height);
    currentSnapshot = buildGrayscaleSnapshot(fixedY, xMin, xMax, values);
    selectedCumulateLine = 'all';
    drawSingleGrayscaleGraph(graphCanvas, currentSnapshot);
    showTemporaryOriginalGuideLine(fixedY, 15000);
    updatePeakPanelsFromCurrentGraphState();
    setStatus(`grayscale 완료: Y=${fixedY}, X[${xMin}, ${xMax}], 64개 샘플`);
    console.log('grayscale snapshot', currentSnapshot);
  } catch (err) {
    setStatus('오류: ' + err.message, true);
  }
});

document.getElementById('btnCumulate').addEventListener('click', () => {
  try {
    if (!hasImage) { setStatus('먼저 캔버스에 이미지를 붙여넣어 주세요 (Ctrl+V).', true); return; }
    const baseY = parseInt(yInput.value, 10);
    const lineCount = parseInt(lineCountInput.value, 10);
    if (isNaN(baseY) || baseY < 0) { setStatus('Y 값을 확인해 주세요 (0 이상의 숫자).', true); return; }
    if (isNaN(lineCount) || lineCount < 1) { setStatus('cumulate line count는 1 이상이어야 합니다.', true); return; }
    const xMin = selection ? selection.xMin : 0;
    const xMax = selection ? selection.xMax : sourceCanvas.width - 1;
    const lines = [];
    for (let i = 0; i < lineCount; i++) {
      const y = baseY - i; // read upward (toward smaller Y) from baseY
      if (y < 0) break;
      const values = getGrayscaleSamplesFromFixedY(sourceCtx, xMin, xMax, y, sourceCanvas.width, sourceCanvas.height);
      lines.push({ y, label: `y=${y}`, color: colorForIndex(i, lineCount), values });
    }
    if (lines.length === 0) { setStatus('읽을 수 있는 라인이 없습니다 (Y 값을 확인하세요).', true); return; }
    currentSnapshot = buildCumulateSnapshot(baseY, lines.length, xMin, xMax, lines);
    selectedCumulateLine = 'all';
    renderCumulateSelector(currentSnapshot);
    drawCumulatedGrayscaleGraph(graphCanvas, currentSnapshot, selectedCumulateLine);
    showTemporaryOriginalGuideLine(lines[0].y, 15000);
    updatePeakPanelsFromCurrentGraphState();
    setStatus(`cumulate 완료: baseY=${baseY}, 라인 ${lines.length}개, X[${xMin}, ${xMax}]`);
    console.log('cumulate snapshot', currentSnapshot);
  } catch (err) {
    setStatus('오류: ' + err.message, true);
  }
});

document.getElementById('btnPasteJson').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    restoreGraphFromJson(text);
  } catch (err) {
    setStatus('클립보드를 읽을 수 없습니다: ' + err.message, true);
  }
});

document.getElementById('peakValuesToggle').addEventListener('click', () => {
  togglePeakPanel('peakValuesPanel', 'peakValuesToggle');
});

document.getElementById('peakSidesToggle').addEventListener('click', () => {
  togglePeakPanel('peakSidesPanel', 'peakSidesToggle');
});

graphCanvas.addEventListener('mousemove', (event) => {
  updateGraphHoverInfo(event);
});

graphCanvas.addEventListener('click', (event) => {
  if (!hasImage || !sourceCanvas) return;
  const rect = graphCanvas.getBoundingClientRect();
  const scaleX = graphCanvas.width / rect.width;
  const clickX = Math.max(0, Math.min(graphCanvas.width - 1, Math.round((event.clientX - rect.left) * scaleX)));

  const left = 30;
  const right = graphCanvas.width - 10;
  if (clickX < left || clickX > right) return;

  const activeLines = getActiveLinesFromGraphState();
  const sampleCount = activeLines && activeLines[0] && Array.isArray(activeLines[0].values) ? activeLines[0].values.length : 0;
  if (sampleCount <= 0) return;

  const sampleIndex = getSampleIndexFromCanvasX(clickX, sampleCount);
  const mappedX = currentSnapshot && Number.isFinite(currentSnapshot.graphXMin) && Number.isFinite(currentSnapshot.graphXMax)
    ? getOriginalXFromGraphSampleIndex(sampleIndex, sampleCount, currentSnapshot.graphXMin, currentSnapshot.graphXMax)
    : Math.max(0, Math.min(sourceCanvas.width - 1, Math.round((sampleIndex / Math.max(1, sampleCount - 1)) * (sourceCanvas.width - 1))));
  showTemporaryOriginalVerticalGuideLine(mappedX, 15000);
});

graphCanvas.addEventListener('mouseleave', () => {
  hoverGuideState.active = false;
  renderCurrentGraphWithHoverGuide();
  setGraphHoverInfo('graph cursor: x=-, y=-, color=-');
});

if (peakModeSelect) {
  peakModeSelect.addEventListener('change', () => {
    updatePeakPanelsFromCurrentGraphState();
  });
}

if (plateauToleranceInput) {
  plateauToleranceInput.addEventListener('change', () => {
    updatePeakPanelsFromCurrentGraphState();
  });
}

if (reboundModeSelect) {
  reboundModeSelect.addEventListener('change', () => {
    updatePeakPanelsFromCurrentGraphState();
  });
}

if (reboundDeltaInput) {
  reboundDeltaInput.addEventListener('change', () => {
    updatePeakPanelsFromCurrentGraphState();
  });
}

updatePeakPanelsFromCurrentGraphState();
setOriginalHoverInfo('original cursor: x=-, y=-');
setGraphHoverInfo('graph cursor: x=-, y=-, color=-');
