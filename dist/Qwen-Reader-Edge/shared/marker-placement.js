(function attachMarkerPlacement(global) {
  'use strict';

  const DEFAULT_GAP = 6;
  const DEFAULT_VIEWPORT_PADDING = 8;

  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function normalizeRect(value) {
    if (!value) return null;

    const left = finiteNumber(value.left);
    const top = finiteNumber(value.top);
    let right = finiteNumber(value.right);
    let bottom = finiteNumber(value.bottom);
    const width = finiteNumber(value.width);
    const height = finiteNumber(value.height);

    if (left === null || top === null) return null;
    if (right === null && width !== null) right = left + width;
    if (bottom === null && height !== null) bottom = top + height;
    if (right === null || bottom === null || right <= left || bottom <= top) return null;

    return { left, top, right, bottom };
  }

  function normalizeViewport(value, padding) {
    if (!value) return null;

    const left = finiteNumber(value.left) ?? 0;
    const top = finiteNumber(value.top) ?? 0;
    let right = finiteNumber(value.right);
    let bottom = finiteNumber(value.bottom);
    const width = finiteNumber(value.width);
    const height = finiteNumber(value.height);

    if (right === null && width !== null) right = left + width;
    if (bottom === null && height !== null) bottom = top + height;
    if (right === null || bottom === null) return null;

    const inset = Math.max(0, padding);
    const viewport = {
      left: left + inset,
      top: top + inset,
      right: right - inset,
      bottom: bottom - inset
    };

    return viewport.right > viewport.left && viewport.bottom > viewport.top ? viewport : null;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function candidate(left, top, width, height, placement) {
    return {
      left,
      top,
      right: left + width,
      bottom: top + height,
      placement
    };
  }

  function isInside(rect, viewport) {
    return rect.left >= viewport.left
      && rect.top >= viewport.top
      && rect.right <= viewport.right
      && rect.bottom <= viewport.bottom;
  }

  function intersects(first, second) {
    return first.left < second.right
      && first.right > second.left
      && first.top < second.bottom
      && first.bottom > second.top;
  }

  function chooseMarkerPlacement(options) {
    const input = options || {};
    const markerWidth = finiteNumber(input.markerWidth);
    const markerHeight = finiteNumber(input.markerHeight);
    if (markerWidth === null || markerHeight === null || markerWidth <= 0 || markerHeight <= 0) {
      return null;
    }

    const sentenceRects = Array.from(input.sentenceRects || [])
      .map(normalizeRect)
      .filter(Boolean)
      .sort((first, second) => first.top - second.top || first.left - second.left);
    if (!sentenceRects.length) return null;

    const gap = Math.max(0, finiteNumber(input.gap) ?? DEFAULT_GAP);
    const viewportPadding = Math.max(
      0,
      finiteNumber(input.viewportPadding) ?? DEFAULT_VIEWPORT_PADDING
    );
    const viewport = normalizeViewport(input.viewport, viewportPadding);
    if (!viewport || markerWidth > viewport.right - viewport.left || markerHeight > viewport.bottom - viewport.top) {
      return null;
    }

    const occupiedRects = Array.from(input.occupiedRects || [])
      .map(normalizeRect)
      .filter(Boolean);
    const firstLine = sentenceRects[0];
    const lastLine = sentenceRects.reduce((latest, rect) => (
      rect.bottom > latest.bottom || (rect.bottom === latest.bottom && rect.left < latest.left) ? rect : latest
    ), sentenceRects[0]);
    const leftEdge = Math.min(...sentenceRects.map((rect) => rect.left));
    const rightEdge = Math.max(...sentenceRects.map((rect) => rect.right));
    const topEdge = Math.min(...sentenceRects.map((rect) => rect.top));
    const bottomEdge = Math.max(...sentenceRects.map((rect) => rect.bottom));
    const centeredTop = firstLine.top + ((firstLine.bottom - firstLine.top) - markerHeight) / 2;
    const maximumLeft = viewport.right - markerWidth;

    const candidates = [
      candidate(
        clamp(firstLine.left, viewport.left, maximumLeft),
        topEdge - gap - markerHeight,
        markerWidth,
        markerHeight,
        'above'
      ),
      candidate(leftEdge - gap - markerWidth, centeredTop, markerWidth, markerHeight, 'left'),
      candidate(rightEdge + gap, centeredTop, markerWidth, markerHeight, 'right'),
      candidate(
        clamp(lastLine.left, viewport.left, maximumLeft),
        bottomEdge + gap,
        markerWidth,
        markerHeight,
        'below'
      )
    ];

    for (const placement of candidates) {
      if (!isInside(placement, viewport)) continue;
      if (occupiedRects.some((rect) => intersects(placement, rect))) continue;
      return placement;
    }

    return null;
  }

  global.QwenReaderMarkerPlacement = Object.freeze({
    chooseMarkerPlacement,
    intersects
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
