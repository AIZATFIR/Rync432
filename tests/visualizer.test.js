import { afterEach, describe, expect, it, vi } from 'vitest';
import { Visualizer } from '../public/js/ui/Visualizer.js';

afterEach(() => vi.unstubAllGlobals());

describe('Visualizer playback lifecycle', () => {
  it('does not animate while paused and clears the frame when playback stops', () => {
    const ctx = {
      clearRect: vi.fn(),
      getImageData: vi.fn(),
      createLinearGradient: vi.fn(() => ({ addColorStop() {} })),
      beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, roundRect() {}, fillRect() {}
    };
    const canvas = { width: 300, height: 90, getContext: () => ctx, getBoundingClientRect: () => ({ width: 300, height: 90 }) };
    const audio = { isPlaying: false, getFrequencyData: vi.fn() };
    const requestFrame = vi.fn(() => 7);
    const cancelFrame = vi.fn();
    vi.stubGlobal('window', { devicePixelRatio: 1, addEventListener: vi.fn() });
    vi.stubGlobal('requestAnimationFrame', requestFrame);
    vi.stubGlobal('cancelAnimationFrame', cancelFrame);

    const visualizer = new Visualizer(canvas, audio);
    visualizer.start();
    expect(requestFrame).not.toHaveBeenCalled();
    expect(audio.getFrequencyData).not.toHaveBeenCalled();

    audio.isPlaying = true;
    visualizer.start();
    expect(requestFrame).toHaveBeenCalledOnce();
    expect(audio.getFrequencyData).toHaveBeenCalledOnce();

    visualizer.stop();
    expect(cancelFrame).toHaveBeenCalledWith(7);
    expect(ctx.clearRect).toHaveBeenCalled();
  });
});
