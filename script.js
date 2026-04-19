(() => {
  const DOC_WIDTH = 900;
  const DOC_HEIGHT = 560;
  const MAX_HISTORY = 50;
  const COPY_HINT_DURATION = 1800;
  const MIN_POINTER_DELTA = 0.5;
  const TEXT_EDITOR_PLACEHOLDER = 'Type text';
  const TEXT_TOOL_HINT = 'Shift locks axis · Drag the text handle to place · Click outside or press Enter to commit · Ctrl/Cmd+C copies image · Ctrl/Cmd+V pastes';
  const TEXT_FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const TEXT_BASE_SIZE = 20;
  const TEXT_WEIGHT_BY_THICKNESS = { 2: 300, 5: 500, 10: 700 };

  const elements = {
    canvas: document.getElementById('canvas'),
    canvasWrap: document.getElementById('canvasWrap'),
    placeholder: document.getElementById('placeholder'),
    openBtn: document.getElementById('openBtn'),
    openInput: document.getElementById('openInput'),
    undoBtn: document.getElementById('undoBtn'),
    redoBtn: document.getElementById('redoBtn'),
    downloadBtn: document.getElementById('downloadBtn'),
    copyBtn: document.getElementById('copyBtn'),
    hint: document.getElementById('hint') || document.querySelector('.hint'),
    toolButtons: [...document.querySelectorAll('.tool')],
    colorButtons: [...document.querySelectorAll('.swatch')],
    thicknessButtons: [...document.querySelectorAll('.thick')],
  };

  if (!elements.canvas) {
    return;
  }

  const ctx = elements.canvas.getContext('2d');
  if (!ctx) {
    return;
  }

  const assetUrls = new Set();
  const history = {
    undo: [],
    redo: [],
  };
  const defaultHint = elements.hint ? elements.hint.textContent : '';

  const state = {
    tool: 'pen',
    color: '#ef4444',
    thickness: 5,
    imageAsset: null,
    imageRect: null,
    annotations: [],
    draft: null,
    activePointerId: null,
  };

  let dragDepth = 0;
  let hintTimer = null;

  function clonePoint(point) {
    return { x: point.x, y: point.y };
  }

  function cloneRect(rect) {
    return rect ? { ...rect } : null;
  }

  function cloneAnnotation(annotation) {
    if (annotation.type === 'pen') {
      return {
        ...annotation,
        points: annotation.points.map(clonePoint),
      };
    }

    if (annotation.type === 'text') {
      return {
        ...annotation,
        position: clonePoint(annotation.position),
      };
    }

    return {
      ...annotation,
      from: clonePoint(annotation.from),
      to: clonePoint(annotation.to),
    };
  }

  function captureDocumentState() {
    return {
      imageAsset: state.imageAsset,
      imageRect: cloneRect(state.imageRect),
      annotations: state.annotations.map(cloneAnnotation),
    };
  }

  function pushHistoryEntry(stack, entry) {
    stack.push(entry);
    if (stack.length > MAX_HISTORY) {
      stack.shift();
    }
  }

  function restoreDocumentState(snapshot) {
    if (typeof finalizeTextEditor === 'function') {
      finalizeTextEditor(true);
    }
    state.imageAsset = snapshot.imageAsset;
    state.imageRect = cloneRect(snapshot.imageRect);
    state.annotations = snapshot.annotations.map(cloneAnnotation);
    state.draft = null;
    state.activePointerId = null;
    updatePlaceholder();
    updateHistoryButtons();
    render();
  }

  function pushUndoSnapshot() {
    pushHistoryEntry(history.undo, captureDocumentState());
    history.redo.length = 0;
    updateHistoryButtons();
  }

  function updateHistoryButtons() {
    elements.undoBtn.disabled = history.undo.length === 0;
    elements.redoBtn.disabled = history.redo.length === 0;
  }

  function undo() {
    if (!history.undo.length) {
      return;
    }

    pushHistoryEntry(history.redo, captureDocumentState());
    restoreDocumentState(history.undo.pop());
  }

  function redo() {
    if (!history.redo.length) {
      return;
    }

    pushHistoryEntry(history.undo, captureDocumentState());
    restoreDocumentState(history.redo.pop());
  }

  function setButtonGroupState(buttons, dataKey, activeValue) {
    buttons.forEach((button) => {
      const isActive = button.dataset[dataKey] === String(activeValue);
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    });
  }

  function setTool(tool) {
    if (state.tool !== tool && typeof finalizeTextEditor === 'function') {
      finalizeTextEditor(false);
    }
    state.tool = tool;
    setButtonGroupState(elements.toolButtons, 'tool', tool);
    if (elements.canvas) {
      elements.canvas.style.cursor = tool === 'text' ? 'text' : 'crosshair';
    }
    if (!hintTimer) {
      resetHint();
    }
  }

  function setColor(color) {
    state.color = color;
    setButtonGroupState(elements.colorButtons, 'color', color);
    if (typeof textEditorState !== 'undefined' && textEditorState.annotation) {
      textEditorState.annotation.color = color;
      updateTextEditorPosition();
    }
  }

  function setThickness(thickness) {
    state.thickness = thickness;
    setButtonGroupState(elements.thicknessButtons, 'thick', thickness);
    if (typeof textEditorState !== 'undefined' && textEditorState.annotation) {
      textEditorState.annotation.thickness = thickness;
      updateTextEditorPosition();
    }
  }

  function updatePlaceholder() {
    elements.placeholder.classList.toggle('hidden', Boolean(state.imageAsset));
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function distance(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  function fitImageRect(naturalWidth, naturalHeight) {
    const scale = Math.min(DOC_WIDTH / naturalWidth, DOC_HEIGHT / naturalHeight, 1);
    const width = naturalWidth * scale;
    const height = naturalHeight * scale;

    return {
      x: (DOC_WIDTH - width) / 2,
      y: (DOC_HEIGHT - height) / 2,
      w: width,
      h: height,
      naturalW: naturalWidth,
      naturalH: naturalHeight,
    };
  }

  function getCanvasPoint(event) {
    const rect = elements.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return { x: 0, y: 0 };
    }

    return {
      x: clamp(((event.clientX - rect.left) / rect.width) * DOC_WIDTH, 0, DOC_WIDTH),
      y: clamp(((event.clientY - rect.top) / rect.height) * DOC_HEIGHT, 0, DOC_HEIGHT),
    };
  }

  function lockAxis(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
      return { x: to.x, y: from.y };
    }
    return { x: from.x, y: to.y };
  }

  function lockAspect(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const side = Math.max(Math.abs(dx), Math.abs(dy));

    return {
      x: from.x + (dx === 0 ? side : Math.sign(dx) * side),
      y: from.y + (dy === 0 ? side : Math.sign(dy) * side),
    };
  }

  function normalizeAnnotation(annotation) {
    if (annotation.type === 'pen' || annotation.type === 'text') {
      return cloneAnnotation(annotation);
    }

    const normalized = cloneAnnotation(annotation);
    if ((normalized.type === 'line' || normalized.type === 'arrow') && normalized.axisLocked) {
      normalized.to = lockAxis(normalized.from, normalized.to);
    }

    if ((normalized.type === 'rect' || normalized.type === 'circle') && normalized.lockAspect) {
      normalized.to = lockAspect(normalized.from, normalized.to);
    }

    return normalized;
  }

  function applyStroke(targetCtx, annotation) {
    targetCtx.strokeStyle = annotation.color;
    targetCtx.fillStyle = annotation.color;
    targetCtx.lineWidth = annotation.thickness;
    targetCtx.lineCap = 'round';
    targetCtx.lineJoin = 'round';
  }

  function drawPen(targetCtx, annotation) {
    applyStroke(targetCtx, annotation);
    if (annotation.points.length === 1) {
      const point = annotation.points[0];
      targetCtx.beginPath();
      targetCtx.arc(point.x, point.y, annotation.thickness / 2, 0, Math.PI * 2);
      targetCtx.fill();
      return;
    }

    targetCtx.beginPath();
    targetCtx.moveTo(annotation.points[0].x, annotation.points[0].y);
    annotation.points.slice(1).forEach((point) => {
      targetCtx.lineTo(point.x, point.y);
    });
    targetCtx.stroke();
  }

  function drawLine(targetCtx, annotation) {
    applyStroke(targetCtx, annotation);
    targetCtx.beginPath();
    targetCtx.moveTo(annotation.from.x, annotation.from.y);
    targetCtx.lineTo(annotation.to.x, annotation.to.y);
    targetCtx.stroke();
  }

  function drawArrow(targetCtx, annotation) {
    applyStroke(targetCtx, annotation);
    const headLength = Math.max(10, annotation.thickness * 3);
    const angle = Math.atan2(annotation.to.y - annotation.from.y, annotation.to.x - annotation.from.x);
    const baseInset = headLength * Math.cos(Math.PI / 6);
    const lineEndX = annotation.to.x - baseInset * Math.cos(angle);
    const lineEndY = annotation.to.y - baseInset * Math.sin(angle);

    targetCtx.beginPath();
    targetCtx.moveTo(annotation.from.x, annotation.from.y);
    targetCtx.lineTo(lineEndX, lineEndY);
    targetCtx.stroke();

    targetCtx.beginPath();
    targetCtx.moveTo(annotation.to.x, annotation.to.y);
    targetCtx.lineTo(
      annotation.to.x - headLength * Math.cos(angle - Math.PI / 6),
      annotation.to.y - headLength * Math.sin(angle - Math.PI / 6)
    );
    targetCtx.lineTo(
      annotation.to.x - headLength * Math.cos(angle + Math.PI / 6),
      annotation.to.y - headLength * Math.sin(angle + Math.PI / 6)
    );
    targetCtx.closePath();
    targetCtx.fill();
  }

  function drawRect(targetCtx, annotation) {
    applyStroke(targetCtx, annotation);
    targetCtx.beginPath();
    targetCtx.rect(
      Math.min(annotation.from.x, annotation.to.x),
      Math.min(annotation.from.y, annotation.to.y),
      Math.abs(annotation.to.x - annotation.from.x),
      Math.abs(annotation.to.y - annotation.from.y)
    );
    targetCtx.stroke();
  }

  function drawEllipse(targetCtx, annotation) {
    applyStroke(targetCtx, annotation);
    const centerX = (annotation.from.x + annotation.to.x) / 2;
    const centerY = (annotation.from.y + annotation.to.y) / 2;
    const radiusX = Math.abs(annotation.to.x - annotation.from.x) / 2;
    const radiusY = Math.abs(annotation.to.y - annotation.from.y) / 2;

    targetCtx.beginPath();
    targetCtx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, Math.PI * 2);
    targetCtx.stroke();
  }

  function getTextFontWeight(thickness) {
    return TEXT_WEIGHT_BY_THICKNESS[thickness] || 500;
  }

  function getTextFontString(annotation) {
    return `${getTextFontWeight(annotation.thickness)} ${TEXT_BASE_SIZE}px ${TEXT_FONT_FAMILY}`;
  }

  function splitTextLines(text) {
    return String(text == null ? '' : text).split(/\r?\n/);
  }

  function measureTextAnnotation(annotation) {
    const lines = splitTextLines(annotation.text);
    const lineHeight = TEXT_BASE_SIZE * 1.2;
    const prevFont = ctx.font;
    ctx.font = getTextFontString(annotation);
    let maxWidth = 0;
    lines.forEach((line) => {
      const metrics = ctx.measureText(line || ' ');
      if (metrics.width > maxWidth) maxWidth = metrics.width;
    });
    ctx.font = prevFont;
    return {
      width: Math.max(10, maxWidth),
      height: Math.max(lineHeight, lines.length * lineHeight),
      lineHeight,
      lines,
    };
  }

  function drawText(targetCtx, annotation) {
    targetCtx.fillStyle = annotation.color;
    targetCtx.font = getTextFontString(annotation);
    targetCtx.textBaseline = 'top';
    const lines = splitTextLines(annotation.text);
    const lineHeight = TEXT_BASE_SIZE * 1.2;
    lines.forEach((line, index) => {
      targetCtx.fillText(line, annotation.position.x, annotation.position.y + index * lineHeight);
    });
  }

  function drawAnnotation(targetCtx, annotation) {
    const normalized = normalizeAnnotation(annotation);
    if (normalized.type === 'pen') {
      drawPen(targetCtx, normalized);
      return;
    }

    if (normalized.type === 'text') {
      drawText(targetCtx, normalized);
      return;
    }

    if (normalized.type === 'line') {
      drawLine(targetCtx, normalized);
      return;
    }

    if (normalized.type === 'arrow') {
      drawArrow(targetCtx, normalized);
      return;
    }

    if (normalized.type === 'rect') {
      drawRect(targetCtx, normalized);
      return;
    }

    drawEllipse(targetCtx, normalized);
  }

  function renderScene(targetCtx, options = {}) {
    const crop = options.crop || { x: 0, y: 0, w: DOC_WIDTH, h: DOC_HEIGHT };
    const outputWidth = options.outputWidth || targetCtx.canvas.width;
    const outputHeight = options.outputHeight || targetCtx.canvas.height;
    const includeDraft = options.includeDraft || false;

    targetCtx.save();
    targetCtx.setTransform(1, 0, 0, 1, 0, 0);
    targetCtx.clearRect(0, 0, outputWidth, outputHeight);
    targetCtx.fillStyle = '#ffffff';
    targetCtx.fillRect(0, 0, outputWidth, outputHeight);
    targetCtx.scale(outputWidth / crop.w, outputHeight / crop.h);
    targetCtx.translate(-crop.x, -crop.y);

    if (state.imageAsset && state.imageRect) {
      targetCtx.drawImage(
        state.imageAsset.img,
        state.imageRect.x,
        state.imageRect.y,
        state.imageRect.w,
        state.imageRect.h
      );
    }

    state.annotations.forEach((annotation) => {
      drawAnnotation(targetCtx, annotation);
    });

    if (includeDraft && state.draft) {
      drawAnnotation(targetCtx, state.draft);
    }

    targetCtx.restore();
  }

  function render() {
    renderScene(ctx, { includeDraft: true });
  }

  function resizeCanvas() {
    const rect = elements.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const targetWidth = Math.max(1, Math.round(rect.width * dpr));
    const targetHeight = Math.max(1, Math.round(rect.height * dpr));

    if (elements.canvas.width === targetWidth && elements.canvas.height === targetHeight) {
      return;
    }

    elements.canvas.width = targetWidth;
    elements.canvas.height = targetHeight;
    render();
    if (typeof updateTextEditorPosition === 'function') {
      updateTextEditorPosition();
    }
  }

  function rectToBounds(rect) {
    if (!rect) {
      return null;
    }

    return {
      minX: rect.x,
      minY: rect.y,
      maxX: rect.x + rect.w,
      maxY: rect.y + rect.h,
    };
  }

  function unionBounds(bounds, nextBounds) {
    if (!nextBounds) {
      return bounds;
    }

    if (!bounds) {
      return { ...nextBounds };
    }

    return {
      minX: Math.min(bounds.minX, nextBounds.minX),
      minY: Math.min(bounds.minY, nextBounds.minY),
      maxX: Math.max(bounds.maxX, nextBounds.maxX),
      maxY: Math.max(bounds.maxY, nextBounds.maxY),
    };
  }

  function pointsToBounds(points, padding) {
    if (!points.length) {
      return null;
    }

    let minX = points[0].x;
    let minY = points[0].y;
    let maxX = points[0].x;
    let maxY = points[0].y;

    points.slice(1).forEach((point) => {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    });

    return {
      minX: minX - padding,
      minY: minY - padding,
      maxX: maxX + padding,
      maxY: maxY + padding,
    };
  }

  function getAnnotationBounds(annotation) {
    const normalized = normalizeAnnotation(annotation);
    const padding = normalized.thickness / 2 + 2;

    if (normalized.type === 'pen') {
      return pointsToBounds(normalized.points, padding);
    }

    if (normalized.type === 'text') {
      const metrics = measureTextAnnotation(normalized);
      return {
        minX: normalized.position.x - 2,
        minY: normalized.position.y - 2,
        maxX: normalized.position.x + metrics.width + 2,
        maxY: normalized.position.y + metrics.height + 2,
      };
    }

    if (normalized.type === 'line') {
      return pointsToBounds([normalized.from, normalized.to], padding);
    }

    if (normalized.type === 'arrow') {
      const headLength = Math.max(10, normalized.thickness * 3);
      return pointsToBounds(
        [
          normalized.from,
          normalized.to,
          { x: normalized.to.x + headLength, y: normalized.to.y + headLength },
          { x: normalized.to.x - headLength, y: normalized.to.y - headLength },
        ],
        padding
      );
    }

    return {
      minX: Math.min(normalized.from.x, normalized.to.x) - padding,
      minY: Math.min(normalized.from.y, normalized.to.y) - padding,
      maxX: Math.max(normalized.from.x, normalized.to.x) + padding,
      maxY: Math.max(normalized.from.y, normalized.to.y) + padding,
    };
  }

  function getAllAnnotationBounds() {
    return state.annotations.reduce((bounds, annotation) => {
      return unionBounds(bounds, getAnnotationBounds(annotation));
    }, null);
  }

  function boundsToCrop(bounds) {
    const minX = clamp(Math.floor(bounds.minX), 0, DOC_WIDTH);
    const minY = clamp(Math.floor(bounds.minY), 0, DOC_HEIGHT);
    const maxX = clamp(Math.ceil(bounds.maxX), 0, DOC_WIDTH);
    const maxY = clamp(Math.ceil(bounds.maxY), 0, DOC_HEIGHT);

    return {
      x: minX,
      y: minY,
      w: Math.max(1, maxX - minX),
      h: Math.max(1, maxY - minY),
    };
  }

  function getExportCrop() {
    if (!state.imageAsset || !state.imageRect) {
      return { x: 0, y: 0, w: DOC_WIDTH, h: DOC_HEIGHT };
    }

    const bounds = unionBounds(rectToBounds(state.imageRect), getAllAnnotationBounds());
    return boundsToCrop(bounds);
  }

  function getExportDimensions(crop) {
    if (!state.imageRect) {
      return {
        width: DOC_WIDTH,
        height: DOC_HEIGHT,
      };
    }

    const scale = state.imageRect.naturalW / state.imageRect.w;
    return {
      width: Math.max(1, Math.round(crop.w * scale)),
      height: Math.max(1, Math.round(crop.h * scale)),
    };
  }

  function buildExportCanvas() {
    const crop = getExportCrop();
    const { width, height } = getExportDimensions(crop);
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = width;
    exportCanvas.height = height;

    const exportContext = exportCanvas.getContext('2d');
    if (!exportContext) {
      return null;
    }

    exportContext.imageSmoothingEnabled = true;
    exportContext.imageSmoothingQuality = 'high';
    renderScene(exportContext, {
      crop,
      outputWidth: width,
      outputHeight: height,
    });

    return exportCanvas;
  }

  function canvasToBlob(sourceCanvas) {
    return new Promise((resolve) => {
      sourceCanvas.toBlob(resolve, 'image/png');
    });
  }

  async function downloadExport() {
    const exportCanvas = buildExportCanvas();
    if (!exportCanvas) {
      flashHint('Nothing to export');
      return;
    }

    const blob = await canvasToBlob(exportCanvas);
    if (!blob) {
      flashHint('Export failed');
      return;
    }

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'annotation.png';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    flashHint('Downloaded annotation.png');
  }

  function canWriteImageClipboard() {
    return Boolean(navigator.clipboard && window.ClipboardItem);
  }

  async function copyCanvasToClipboard() {
    if (!canWriteImageClipboard()) {
      flashHint('Clipboard copy is not supported in this browser');
      return false;
    }

    try {
      const exportCanvas = buildExportCanvas();
      if (!exportCanvas) {
        flashHint('Nothing to copy');
        return false;
      }

      const blob = await canvasToBlob(exportCanvas);
      if (!blob) {
        throw new Error('Could not encode image');
      }

      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      flashHint('Copied to clipboard');
      return true;
    } catch (error) {
      console.warn('Clipboard copy failed:', error);
      flashHint('Copy failed. Use Download instead.');
      return false;
    }
  }

  function getBaseHint() {
    return state.tool === 'text' ? TEXT_TOOL_HINT : defaultHint;
  }

  function resetHint() {
    if (!elements.hint) {
      return;
    }

    elements.hint.textContent = getBaseHint();
  }

  function flashHint(message) {
    if (!elements.hint) {
      return;
    }

    elements.hint.textContent = message;
    window.clearTimeout(hintTimer);
    hintTimer = window.setTimeout(() => {
      hintTimer = null;
      resetHint();
    }, COPY_HINT_DURATION);
  }

  function createDraft(point, shiftKey) {
    if (state.tool === 'pen') {
      return {
        type: 'pen',
        color: state.color,
        thickness: state.thickness,
        points: [point],
      };
    }

    return {
      type: state.tool,
      color: state.color,
      thickness: state.thickness,
      from: point,
      to: point,
      axisLocked: shiftKey && (state.tool === 'line' || state.tool === 'arrow'),
      lockAspect: shiftKey && (state.tool === 'rect' || state.tool === 'circle'),
    };
  }

  function updateDraft(point, shiftKey) {
    if (!state.draft) {
      return;
    }

    if (state.draft.type === 'pen') {
      const lastPoint = state.draft.points[state.draft.points.length - 1];
      if (distance(lastPoint, point) >= MIN_POINTER_DELTA) {
        state.draft.points.push(point);
      }
      return;
    }

    state.draft.to = point;
    state.draft.axisLocked = shiftKey && (state.draft.type === 'line' || state.draft.type === 'arrow');
    state.draft.lockAspect = shiftKey && (state.draft.type === 'rect' || state.draft.type === 'circle');
  }

  function isDrawableAnnotation(annotation) {
    if (annotation.type === 'pen') {
      return annotation.points.length > 0;
    }

    if (annotation.type === 'text') {
      return String(annotation.text || '').trim().length > 0;
    }

    if (annotation.type === 'line' || annotation.type === 'arrow') {
      return distance(annotation.from, annotation.to) >= MIN_POINTER_DELTA;
    }

    return (
      Math.abs(annotation.to.x - annotation.from.x) >= MIN_POINTER_DELTA ||
      Math.abs(annotation.to.y - annotation.from.y) >= MIN_POINTER_DELTA
    );
  }

  function commitDraft() {
    if (!state.draft) {
      return;
    }

    const finalized = normalizeAnnotation(state.draft);
    state.draft = null;

    if (!isDrawableAnnotation(finalized)) {
      render();
      return;
    }

    pushUndoSnapshot();
    state.annotations.push(finalized);
    render();
  }

  function cancelDraft() {
    state.draft = null;
    state.activePointerId = null;
    render();
  }

  function isPrimaryDrawingPointer(event) {
    return event.isPrimary !== false && (event.pointerType !== 'mouse' || event.button === 0);
  }

  function createImageAsset(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      assetUrls.add(url);

      img.onload = () => {
        resolve({
          img,
          url,
          naturalW: img.naturalWidth || img.width,
          naturalH: img.naturalHeight || img.height,
        });
      };

      img.onerror = () => {
        assetUrls.delete(url);
        URL.revokeObjectURL(url);
        reject(new Error('Could not load image'));
      };

      img.src = url;
    });
  }

  async function loadImageFile(file) {
    if (!file || !file.type.startsWith('image/')) {
      flashHint('Choose an image file');
      return false;
    }

    try {
      const asset = await createImageAsset(file);
      pushUndoSnapshot();
      state.imageAsset = asset;
      state.imageRect = fitImageRect(asset.naturalW, asset.naturalH);
      state.annotations = [];
      state.draft = null;
      updatePlaceholder();
      render();
      flashHint(file.name ? `${file.name} loaded` : 'Image loaded');
      return true;
    } catch (error) {
      console.warn('Image load failed:', error);
      flashHint('Could not load that image');
      return false;
    }
  }

  function getImageFileFromItems(items) {
    if (!items) {
      return null;
    }

    for (const item of items) {
      if (item.type && item.type.startsWith('image/')) {
        return item.getAsFile ? item.getAsFile() : item;
      }
    }

    return null;
  }

  function getImageFileFromDataTransfer(dataTransfer) {
    if (!dataTransfer || !dataTransfer.files) {
      return null;
    }

    for (const file of dataTransfer.files) {
      if (file.type && file.type.startsWith('image/')) {
        return file;
      }
    }

    return null;
  }

  const textEditorState = {
    element: null,
    input: null,
    handle: null,
    annotation: null,
    dragging: false,
    dragPointerId: null,
    dragOffset: { x: 0, y: 0 },
    outsideHandler: null,
    suppressNextCanvasPointerDown: false,
  };

  function isTextEditorActive() {
    return Boolean(textEditorState.element);
  }

  function getTextEditorValue() {
    const input = textEditorState.input;
    if (!input) {
      return '';
    }

    return input.innerText.replace(/\r/g, '');
  }

  function syncTextEditorValue() {
    const input = textEditorState.input;
    const annotation = textEditorState.annotation;
    if (!input || !annotation) {
      return;
    }

    annotation.text = getTextEditorValue();
    input.dataset.empty = String(annotation.text.trim().length === 0);
  }

  function focusTextEditorInput(collapseToEnd = false) {
    const input = textEditorState.input;
    if (!input) {
      return;
    }

    input.focus();

    if (!collapseToEnd) {
      return;
    }

    const selection = window.getSelection();
    if (!selection) {
      return;
    }

    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function getActiveTextEditorMetrics() {
    const el = textEditorState.element;
    const input = textEditorState.input;
    const handle = textEditorState.handle;
    if (!el || !input || !handle) {
      return null;
    }

    const { sx, sy } = getCanvasScale();
    if (!sx || !sy) {
      return null;
    }

    const editorRect = el.getBoundingClientRect();
    const inputRect = input.getBoundingClientRect();
    const handleRect = handle.getBoundingClientRect();
    const inputStyle = window.getComputedStyle(input);
    const paddingLeft = Number.parseFloat(inputStyle.paddingLeft || '0') / sx;
    const paddingTop = Number.parseFloat(inputStyle.paddingTop || '0') / sy;
    return {
      width: editorRect.width / sx,
      height: editorRect.height / sy,
      handleHeight: handleRect.height / sy,
      contentOffsetX: (inputRect.left - editorRect.left) / sx + paddingLeft,
      contentOffsetY: (inputRect.top - editorRect.top) / sy + paddingTop,
    };
  }

  function getCanvasScale() {
    const rect = elements.canvas.getBoundingClientRect();
    return {
      sx: rect.width / DOC_WIDTH,
      sy: rect.height / DOC_HEIGHT,
    };
  }

  function updateTextEditorPosition() {
    const el = textEditorState.element;
    const input = textEditorState.input;
    const annotation = textEditorState.annotation;
    if (!el || !input || !annotation) return;

    const { sx, sy } = getCanvasScale();
    el.style.fontSize = `${TEXT_BASE_SIZE * sy}px`;
    el.style.fontWeight = String(getTextFontWeight(annotation.thickness));
    el.style.color = annotation.color;
    el.style.fontFamily = TEXT_FONT_FAMILY;
    syncTextEditorValue();

    const metrics = getActiveTextEditorMetrics();
    if (!metrics) {
      return;
    }

    const maxX = Math.max(metrics.contentOffsetX, DOC_WIDTH - (metrics.width - metrics.contentOffsetX));
    const maxY = Math.max(metrics.contentOffsetY, DOC_HEIGHT - (metrics.height - metrics.contentOffsetY));
    annotation.position.x = clamp(annotation.position.x, metrics.contentOffsetX, maxX);
    annotation.position.y = clamp(
      annotation.position.y,
      metrics.contentOffsetY,
      maxY
    );

    el.style.left = `${(annotation.position.x - metrics.contentOffsetX) * sx}px`;
    el.style.top = `${(annotation.position.y - metrics.contentOffsetY) * sy}px`;
  }

  function startTextEditor(point) {
    if (isTextEditorActive()) {
      finalizeTextEditor(false);
    }

    const annotation = {
      type: 'text',
      color: state.color,
      thickness: state.thickness,
      position: clonePoint(point),
      text: '',
    };

    const el = document.createElement('div');
    el.className = 'text-editor';

    const handle = document.createElement('div');
    handle.className = 'text-editor-handle';
    handle.setAttribute('aria-hidden', 'true');

    const input = document.createElement('div');
    input.className = 'text-editor-input';
    input.contentEditable = 'true';
    input.spellcheck = false;
    input.dataset.placeholder = TEXT_EDITOR_PLACEHOLDER;
    input.dataset.empty = 'true';
    input.setAttribute('aria-label', 'Text annotation');

    el.append(handle, input);
    elements.canvasWrap.appendChild(el);

    textEditorState.element = el;
    textEditorState.input = input;
    textEditorState.handle = handle;
    textEditorState.annotation = annotation;
    updateTextEditorPosition();

    input.addEventListener('input', () => {
      syncTextEditorValue();
      updateTextEditorPosition();
    });

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        finalizeTextEditor(false);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        finalizeTextEditor(true);
      }
    });

    handle.addEventListener('pointerdown', (event) => {
      if (!isPrimaryDrawingPointer(event)) return;
      event.preventDefault();
      event.stopPropagation();
      textEditorState.dragging = true;
      textEditorState.dragPointerId = event.pointerId;
      el.classList.add('dragging');
      const rect = el.getBoundingClientRect();
      textEditorState.dragOffset.x = event.clientX - rect.left;
      textEditorState.dragOffset.y = event.clientY - rect.top;
      try { handle.setPointerCapture(event.pointerId); } catch (_) {}
    });

    handle.addEventListener('pointermove', (event) => {
      if (!textEditorState.dragging || event.pointerId !== textEditorState.dragPointerId) return;
      event.preventDefault();
      const canvasRect = elements.canvas.getBoundingClientRect();
      const { sx, sy } = getCanvasScale();
      const metrics = getActiveTextEditorMetrics();
      if (!sx || !sy || !metrics) {
        return;
      }

      const leftPx = event.clientX - canvasRect.left - textEditorState.dragOffset.x;
      const topPx = event.clientY - canvasRect.top - textEditorState.dragOffset.y;
      annotation.position.x = leftPx / sx + metrics.contentOffsetX;
      annotation.position.y = topPx / sy + metrics.contentOffsetY;
      updateTextEditorPosition();
    });

    const stopDrag = (event) => {
      if (!textEditorState.dragging || event.pointerId !== textEditorState.dragPointerId) return;
      textEditorState.dragging = false;
      textEditorState.dragPointerId = null;
      el.classList.remove('dragging');
      try { handle.releasePointerCapture(event.pointerId); } catch (_) {}
      focusTextEditorInput(true);
    };
    handle.addEventListener('pointerup', stopDrag);
    handle.addEventListener('pointercancel', stopDrag);

    const outsideHandler = (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!textEditorState.element || !target) return;
      if (textEditorState.element.contains(target)) return;
      if (target.closest('.swatch, .thick')) return;
      if (target === elements.canvas) {
        textEditorState.suppressNextCanvasPointerDown = true;
      }
      finalizeTextEditor(false);
    };
    textEditorState.outsideHandler = outsideHandler;
    setTimeout(() => {
      document.addEventListener('pointerdown', outsideHandler, true);
    }, 0);

    setTimeout(() => {
      focusTextEditorInput();
      updateTextEditorPosition();
    }, 0);
  }

  function finalizeTextEditor(cancel) {
    const el = textEditorState.element;
    const input = textEditorState.input;
    const handle = textEditorState.handle;
    const annotation = textEditorState.annotation;
    if (!el || !input || !annotation) return;

    if (textEditorState.outsideHandler) {
      document.removeEventListener('pointerdown', textEditorState.outsideHandler, true);
      textEditorState.outsideHandler = null;
    }

    if (textEditorState.dragging && textEditorState.dragPointerId != null && handle) {
      try { handle.releasePointerCapture(textEditorState.dragPointerId); } catch (_) {}
    }

    annotation.text = getTextEditorValue();
    el.remove();
    textEditorState.element = null;
    textEditorState.input = null;
    textEditorState.handle = null;
    textEditorState.annotation = null;
    textEditorState.dragging = false;
    textEditorState.dragPointerId = null;

    if (cancel || !isDrawableAnnotation(annotation)) {
      render();
      return;
    }

    pushUndoSnapshot();
    state.annotations.push(normalizeAnnotation(annotation));
    render();
  }

  function hasSelection() {
    const selection = window.getSelection();
    return Boolean(selection && !selection.isCollapsed && selection.toString());
  }

  elements.toolButtons.forEach((button) => {
    button.addEventListener('click', () => {
      setTool(button.dataset.tool);
    });
  });

  elements.colorButtons.forEach((button) => {
    button.addEventListener('click', () => {
      setColor(button.dataset.color);
    });
  });

  elements.thicknessButtons.forEach((button) => {
    button.addEventListener('click', () => {
      setThickness(Number.parseInt(button.dataset.thick, 10));
    });
  });

  elements.openInput.addEventListener('change', async (event) => {
    const [file] = event.target.files || [];
    if (!file) {
      return;
    }

    await loadImageFile(file);
    event.target.value = '';
  });

  elements.undoBtn.addEventListener('click', undo);
  elements.redoBtn.addEventListener('click', redo);
  elements.downloadBtn.addEventListener('click', () => {
    void downloadExport();
  });
  elements.copyBtn.addEventListener('click', () => {
    void copyCanvasToClipboard();
  });

  elements.canvas.addEventListener('pointerdown', (event) => {
    if (textEditorState.suppressNextCanvasPointerDown) {
      textEditorState.suppressNextCanvasPointerDown = false;
      return;
    }

    if (!isPrimaryDrawingPointer(event)) {
      return;
    }

    if (state.tool === 'text') {
      event.preventDefault();
      elements.canvas.focus();
      const point = getCanvasPoint(event);
      startTextEditor(point);
      return;
    }

    event.preventDefault();
    elements.canvas.focus();
    state.activePointerId = event.pointerId;
    elements.canvas.setPointerCapture(event.pointerId);
    state.draft = createDraft(getCanvasPoint(event), event.shiftKey);
    render();
  });

  elements.canvas.addEventListener('pointermove', (event) => {
    if (event.pointerId !== state.activePointerId || !state.draft) {
      return;
    }

    updateDraft(getCanvasPoint(event), event.shiftKey);
    render();
  });

  elements.canvas.addEventListener('pointerup', (event) => {
    if (event.pointerId !== state.activePointerId) {
      return;
    }

    if (elements.canvas.hasPointerCapture(event.pointerId)) {
      elements.canvas.releasePointerCapture(event.pointerId);
    }

    state.activePointerId = null;
    commitDraft();
  });

  elements.canvas.addEventListener('pointercancel', () => {
    cancelDraft();
  });

  elements.canvas.addEventListener('contextmenu', () => {
    elements.canvas.focus();
  });

  elements.canvasWrap.addEventListener('dragenter', (event) => {
    if (!getImageFileFromDataTransfer(event.dataTransfer)) {
      return;
    }

    dragDepth += 1;
    event.preventDefault();
    elements.canvasWrap.classList.add('drag-active');
  });

  elements.canvasWrap.addEventListener('dragover', (event) => {
    if (!getImageFileFromDataTransfer(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });

  elements.canvasWrap.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      elements.canvasWrap.classList.remove('drag-active');
    }
  });

  elements.canvasWrap.addEventListener('drop', async (event) => {
    const file = getImageFileFromDataTransfer(event.dataTransfer);
    dragDepth = 0;
    elements.canvasWrap.classList.remove('drag-active');
    if (!file) {
      return;
    }

    event.preventDefault();
    await loadImageFile(file);
  });

  window.addEventListener('paste', async (event) => {
    const file = getImageFileFromItems(event.clipboardData && event.clipboardData.items);
    if (!file) {
      return;
    }

    event.preventDefault();
    await loadImageFile(file);
  });

  window.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();

    if (mod && key === 'z' && !event.shiftKey) {
      event.preventDefault();
      undo();
      return;
    }

    if ((mod && key === 'y') || (mod && event.shiftKey && key === 'z')) {
      event.preventDefault();
      redo();
      return;
    }

    if (mod && key === 'c' && !hasSelection() && canWriteImageClipboard()) {
      event.preventDefault();
      void copyCanvasToClipboard();
    }
  });

  window.addEventListener('copy', (event) => {
    if (hasSelection() || !canWriteImageClipboard()) {
      return;
    }

    event.preventDefault();
    void copyCanvasToClipboard();
  });

  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('beforeunload', () => {
    assetUrls.forEach((url) => URL.revokeObjectURL(url));
  });

  setTool(state.tool);
  setColor(state.color);
  setThickness(state.thickness);
  updatePlaceholder();
  updateHistoryButtons();
  resizeCanvas();
})();
