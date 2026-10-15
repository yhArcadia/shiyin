import test from 'node:test';
import assert from 'node:assert/strict';
import { zoomGeometry } from '../src/timeline.mjs';

test('连续缩放保持指针下的原视频时间不变', () => {
  const oldWidth = 800, scrollLeft = 200, viewportWidth = 400, anchorPixel = 150;
  const fraction = (scrollLeft + anchorPixel) / oldWidth;
  for (const newWidth of [850, 1040, 1600, 2300]) {
    const next = zoomGeometry({ oldWidth, newWidth, scrollLeft, viewportWidth, anchorPixel });
    assert.ok(Math.abs((next + anchorPixel) / newWidth - fraction) < 1e-10);
  }
});
test('缩回完整视频时视野不越界，左右端点保持可见', () => {
  assert.equal(zoomGeometry({ oldWidth: 1600, newWidth: 400, scrollLeft: 1000, viewportWidth: 400, anchorPixel: 200 }), 0);
  assert.equal(zoomGeometry({ oldWidth: 800, newWidth: 1600, scrollLeft: 0, viewportWidth: 400, anchorPixel: 0 }), 0);
  assert.equal(zoomGeometry({ oldWidth: 800, newWidth: 1600, scrollLeft: 400, viewportWidth: 400, anchorPixel: 400 }), 1200);
});
