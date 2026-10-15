import { MIN_CLIP, formatTime, moveBoundary, roundTime } from './domain.mjs';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Keep the same source time under a chosen screen position while zooming.
export function zoomGeometry({ oldWidth, newWidth, scrollLeft, viewportWidth, anchorPixel }) {
  const anchor = clamp(anchorPixel, 0, viewportWidth);
  const fraction = (scrollLeft + anchor) / Math.max(1, oldWidth);
  return clamp(fraction * newWidth - anchor, 0, Math.max(0, newWidth - viewportWidth));
}

export function createTimelineController({ state, video, getNames, capture, onPaint, onSelect, onMoveBoundary, onCommitDrag, onMerge, isBusy }) {
  const $ = id => document.getElementById(id);
  const scroller = $('timelineScroller'), content = $('timelineContent'), segments = $('segments'), ruler = $('timeRuler');
  const menu = $('boundaryMenu'), region = $('timelineRegion');
  let zoomFrame = null, displayedZoom = 1, selectedBoundary = null;
  let pan = null, boundaryDrag = null, suppressClickUntil = 0;
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  function syncZoomControls() {
    $('zoomSlider').value = state.zoom;
    $('zoomLabel').textContent = state.zoom <= 1.001 ? '完整视频' : `${Number(state.zoom.toFixed(2))} 倍`;
    $('zoomOut').disabled = state.zoom <= 1.001;
    $('zoomIn').disabled = state.zoom >= 15.999;
    content.classList.toggle('is-zoomed', state.zoom > 1.001);
    $('timelineHint').textContent = state.zoom > 1.001 ? '拖动刻度或片段移动视野；单击片段可定位。' : '放大后，拖动刻度或片段可移动时间窗口。';
  }
  function renderRuler() {
    if (!state.duration) return;
    const ticks = clamp(Math.floor(scroller.clientWidth * state.zoom / 80) + 1, 5, 81);
    const precision = state.duration / (ticks - 1) < 1 ? 1 : 0;
    ruler.innerHTML = Array.from({ length: ticks }, (_, i) => `<span style="left:${i / (ticks - 1) * 100}%">${formatTime(state.duration * i / (ticks - 1), precision)}</span>`).join('');
  }
  function closeMenu(restoreFocus = false) {
    const previous = selectedBoundary;
    menu.hidden = true; selectedBoundary = null;
    segments.querySelectorAll('.is-selected').forEach(el => { el.classList.remove('is-selected'); el.setAttribute('aria-expanded', 'false'); });
    if (restoreFocus && previous) segments.querySelector(`[data-boundary-id="${previous}"]`)?.focus();
  }
  function positionMenu() {
    if (!selectedBoundary || menu.hidden) return;
    const handle = segments.querySelector(`[data-boundary-id="${selectedBoundary}"]`);
    if (!handle) { closeMenu(); return; }
    const rect = handle.getBoundingClientRect(), viewport = scroller.getBoundingClientRect(), parent = region.getBoundingClientRect();
    const anchor = rect.left + rect.width / 2;
    if (anchor < viewport.left || anchor > viewport.right) { closeMenu(); return; }
    menu.style.left = `${clamp(anchor - parent.left - menu.offsetWidth / 2, 4, Math.max(4, parent.width - menu.offsetWidth - 4))}px`;
    menu.style.top = `${rect.top - parent.top - menu.offsetHeight - 9}px`;
  }
  function showMenu(id, focus = false) {
    const index = state.clips.findIndex(c => c.id === id);
    if (index <= 0) return;
    closeMenu(); selectedBoundary = id;
    $('boundaryMenuTime').textContent = `${formatTime(state.clips[index].start)} 的切分点`;
    menu.hidden = false;
    const handle = segments.querySelector(`[data-boundary-id="${id}"]`);
    handle?.classList.add('is-selected'); handle?.setAttribute('aria-expanded', 'true');
    positionMenu();
    if (focus) $('removeBoundaryButton').focus();
  }
  function cancelZoom() {
    if (zoomFrame !== null) {
      cancelAnimationFrame(zoomFrame); zoomFrame = null;
      state.zoom = displayedZoom;
      content.style.width = `${state.zoom * 100}%`;
      delete content.dataset.zoomAnimating;
      syncZoomControls(); renderRuler();
    }
  }
  function refreshSegmentLabels() {
    for (const clip of getNames()) {
      const element = segments.querySelector(`[data-segment="${clip.id}"]`);
      if (element) {
        element.textContent = (clip.end - clip.start) / state.duration * state.zoom > 0.08 ? clip.label : '';
        element.setAttribute('aria-label', `定位到 ${clip.label}，${formatTime(clip.start)} 至 ${formatTime(clip.end)}`);
      }
    }
  }
  function zoomTo(value, anchorPixel = scroller.clientWidth / 2) {
    if (!state.file || isBusy()) return;
    const target = roundTime(clamp(value, 1, 16));
    const oldWidth = content.getBoundingClientRect().width, startWidth = Math.max(oldWidth, scroller.clientWidth);
    const oldScroll = scroller.scrollLeft, viewportWidth = scroller.clientWidth;
    cancelZoom(); closeMenu();
    state.zoom = target;
    syncZoomControls();
    const targetWidth = viewportWidth * target;
    const startTime = performance.now(), duration = reducedMotion() ? 0 : 280;
    content.dataset.zoomAnimating = 'true';
    function animate(now) {
      const progress = duration ? Math.min(1, (now - startTime) / duration) : 1;
      const eased = 1 - (1 - progress) ** 3;
      const width = startWidth + (targetWidth - startWidth) * eased;
      displayedZoom = width / viewportWidth;
      content.style.width = `${width}px`;
      scroller.scrollLeft = zoomGeometry({ oldWidth: startWidth, newWidth: width, scrollLeft: oldScroll, viewportWidth, anchorPixel });
      if (progress < 1) zoomFrame = requestAnimationFrame(animate);
      else {
        zoomFrame = null; displayedZoom = target;
        content.style.width = `${target * 100}%`;
        delete content.dataset.zoomAnimating;
        renderRuler(); refreshSegmentLabels(); syncZoomControls();
      }
    }
    zoomFrame = requestAnimationFrame(animate);
  }
  function render() {
    cancelZoom(); closeMenu();
    displayedZoom = state.zoom;
    const names = getNames();
    segments.innerHTML = names.map(clip => `<button class="segment ${clip.checked ? 'is-checked' : ''}" data-segment="${clip.id}" style="left:${clip.start / state.duration * 100}%;width:calc(${(clip.end - clip.start) / state.duration * 100}% - 2px)" aria-label="定位到 ${escape(clip.label)}，${formatTime(clip.start)} 至 ${formatTime(clip.end)}">${(clip.end - clip.start) / state.duration * state.zoom > 0.08 ? escape(clip.label) : ''}</button>`).join('') + state.clips.slice(1).map((clip, i) => `<button class="boundary-handle" data-drag-boundary="${i + 1}" data-boundary-id="${clip.id}" style="left:${clip.start / state.duration * 100}%" aria-label="调整第 ${i + 1} 段与第 ${i + 2} 段的分段位置" aria-expanded="false" aria-controls="boundaryMenu"></button>`).join('');
    content.style.width = `${state.zoom * 100}%`;
    renderRuler(); syncZoomControls(); onPaint();
  }
  function scrollToTime(time) {
    cancelZoom();
    if (state.zoom <= 1.001) return;
    scroller.scrollLeft = Math.max(0, time / state.duration * content.scrollWidth - scroller.clientWidth / 2);
  }
  function reset() {
    cancelZoom(); closeMenu(); pan = null; boundaryDrag = null;
    state.zoom = 1; displayedZoom = 1; scroller.scrollLeft = 0;
    scroller.classList.remove('is-panning');
  }
  function startPan(event) {
    if (!state.file || isBusy() || event.button !== 0 || state.zoom <= 1.001) return;
    cancelZoom(); closeMenu();
    pan = { pointer: event.pointerId, x: event.clientX, y: event.clientY, scrollLeft: scroller.scrollLeft, moved: false, element: event.currentTarget };
  }
  ruler.addEventListener('pointerdown', startPan);
  segments.addEventListener('pointerdown', event => {
    const handle = event.target.closest('[data-drag-boundary]');
    if (!handle) { startPan(event); return; }
    if (isBusy() || event.button !== 0) return;
    event.preventDefault(); cancelZoom(); closeMenu(); video.pause(); state.previewEnd = null;
    boundaryDrag = { pointer: event.pointerId, x: event.clientX, index: Number(handle.dataset.dragBoundary), before: capture(), original: structuredClone(state.clips), changed: false, handle };
  });
  document.addEventListener('pointermove', event => {
    if (boundaryDrag && event.pointerId === boundaryDrag.pointer) {
      const drag = boundaryDrag;
      if (!drag.changed && Math.abs(event.clientX - drag.x) < 4) return;
      event.preventDefault();
      if (!drag.changed) drag.handle.setPointerCapture(event.pointerId);
      const rect = segments.getBoundingClientRect(), { index, original } = drag;
      const point = clamp((event.clientX - rect.left) / rect.width * state.duration, original[index - 1].start + MIN_CLIP, original[index].end - MIN_CLIP);
      try {
        state.clips = moveBoundary(original, index, point); drag.changed = true;
        drag.handle.style.left = `${state.clips[index].start / state.duration * 100}%`;
        for (const button of segments.querySelectorAll('[data-segment]')) {
          const clip = state.clips.find(c => c.id === button.dataset.segment);
          button.style.left = `${clip.start / state.duration * 100}%`;
          button.style.width = `calc(${(clip.end - clip.start) / state.duration * 100}% - 2px)`;
        }
      } catch {}
      return;
    }
    if (!pan || event.pointerId !== pan.pointer) return;
    const distance = event.clientX - pan.x;
    if (!pan.moved) {
      if (Math.abs(distance) < 4) return;
      if (Math.abs(event.clientY - pan.y) > Math.abs(distance) * 1.2) { pan = null; return; }
      pan.moved = true; pan.element.setPointerCapture(event.pointerId);
      scroller.classList.add('is-panning');
    }
    event.preventDefault();
    scroller.scrollLeft = pan.scrollLeft - distance;
  }, { passive: false });
  function finishPointer(event, canceled = false) {
    if (boundaryDrag && event.pointerId === boundaryDrag.pointer) {
      const drag = boundaryDrag; boundaryDrag = null;
      if (drag.changed) {
        suppressClickUntil = performance.now() + 350;
        if (canceled) { state.clips = drag.original; render(); }
        else onCommitDrag(drag.before);
      }
    }
    if (pan && event.pointerId === pan.pointer) {
      if (pan.moved) suppressClickUntil = performance.now() + 350;
      pan = null; scroller.classList.remove('is-panning');
    }
  }
  document.addEventListener('pointerup', event => finishPointer(event));
  document.addEventListener('pointercancel', event => finishPointer(event, true));
  segments.addEventListener('click', event => {
    if (performance.now() < suppressClickUntil || isBusy()) { event.preventDefault(); return; }
    const handle = event.target.closest('[data-boundary-id]');
    if (handle) { showMenu(handle.dataset.boundaryId); return; }
    const button = event.target.closest('[data-segment]');
    if (button) { closeMenu(); const clip = state.clips.find(c => c.id === button.dataset.segment); if (clip) onSelect(clip); }
  });
  segments.addEventListener('keydown', event => {
    const handle = event.target.closest('[data-drag-boundary]'); if (!handle) return;
    if (event.key === 'Enter' || event.code === 'Space') { event.preventDefault(); event.stopPropagation(); showMenu(handle.dataset.boundaryId, true); return; }
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const index = Number(handle.dataset.dragBoundary), delta = (event.shiftKey ? 0.01 : 0.1) * (event.key === 'ArrowRight' ? 1 : -1);
    onMoveBoundary(index, state.clips[index].start + delta);
    segments.querySelector(`[data-drag-boundary="${index}"]`)?.focus();
  });
  $('removeBoundaryButton').addEventListener('click', () => {
    const index = state.clips.findIndex(c => c.id === selectedBoundary);
    closeMenu(); if (index > 0) onMerge(index);
  });
  $('closeBoundaryMenu').addEventListener('click', () => closeMenu(true));
  document.addEventListener('pointerdown', event => { if (!event.target.closest('.boundary-menu, .boundary-handle')) closeMenu(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && selectedBoundary) { event.preventDefault(); closeMenu(true); } });
  scroller.addEventListener('scroll', positionMenu, { passive: true });
  $('zoomIn').addEventListener('click', () => zoomTo(state.zoom * 1.3));
  $('zoomOut').addEventListener('click', () => zoomTo(state.zoom / 1.3));
  $('zoomSlider').addEventListener('input', event => zoomTo(Number(event.target.value)));
  $('zoomSlider').title = '也可以按住 Ctrl，配合鼠标滚轮缩放';
  scroller.addEventListener('wheel', event => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    zoomTo(state.zoom * Math.exp(-event.deltaY * 0.002), event.clientX - scroller.getBoundingClientRect().left);
  }, { passive: false });
  new ResizeObserver(() => {
    if (!state.file || zoomFrame !== null) return;
    content.style.width = `${state.zoom * 100}%`; renderRuler(); positionMenu();
  }).observe(scroller);
  return { render, scrollToTime, reset, closeMenu, refreshLabels: refreshSegmentLabels };
}
