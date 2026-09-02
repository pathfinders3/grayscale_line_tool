"use strict";

// ---------- Element refs ----------
const originalCanvas = document.getElementById('originalCanvas');
const originalCtx = originalCanvas.getContext('2d');
const graphCanvas = document.getElementById('graphCanvas');
const yInput = document.getElementById('yInput');
const lineCountInput = document.getElementById('lineCountInput');
const statusEl = document.getElementById('status');

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
  selection = createDefaultSelection(bitmap.width, bitmap.height);
  const midY = Math.round((selection.yTop + selection.yBottom) / 2);
  yInput.value = midY;
  redrawOriginalCanvas();

  try {
    const values = getGrayscaleSamplesFromFixedY(sourceCtx, selection.xMin, selection.xMax, midY, sourceCanvas.width, sourceCanvas.height);
    currentSnapshot = buildGrayscaleSnapshot(midY, selection.xMin, selection.xMax, values);
    drawSingleGrayscaleGraph(graphCanvas, currentSnapshot);
    setStatus(`이미지 로드 완료 (${bitmap.width} x ${bitmap.height}). 기본 선택 영역이 자동 적용되었습니다. 드래그로 직접 영역을 바꿀 수 있습니다.`);
  } catch (err) {
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
      drawCumulatedGrayscaleGraph(graphCanvas, currentSnapshot);
    }
  }

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
  if (!isDragging || !hasImage) return;
  const { x, y } = getCanvasCoords(e);
  selection.xMin = Math.max(0, Math.min(dragStartX, x));
  selection.xMax = Math.min(originalCanvas.width - 1, Math.max(dragStartX, x));
  selection.yTop = Math.max(0, Math.min(dragStartY, y));
  selection.yBottom = Math.min(originalCanvas.height - 1, Math.max(dragStartY, y));
  redrawOriginalCanvas();
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

function drawSingleGrayscaleGraph(canvas, snapshot) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!snapshot || !Array.isArray(snapshot.values) || snapshot.values.length === 0) {
    setStatus('그릴 데이터가 없습니다.', true);
    return;
  }
  drawAxes(ctx, canvas);
  plotLine(ctx, canvas, snapshot.values, snapshot.yMin, snapshot.yMax, '#4da6ff');
}

function drawCumulatedGrayscaleGraph(canvas, snapshot) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!snapshot || !Array.isArray(snapshot.lines) || snapshot.lines.length === 0) {
    setStatus('그릴 데이터가 없습니다.', true);
    return;
  }
  drawAxes(ctx, canvas);
  for (const line of snapshot.lines) {
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
    drawCumulatedGrayscaleGraph(graphCanvas, snapshot);
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
    drawSingleGrayscaleGraph(graphCanvas, currentSnapshot);
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
    drawCumulatedGrayscaleGraph(graphCanvas, currentSnapshot);
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
