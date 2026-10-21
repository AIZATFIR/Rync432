import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../public/js/auth/FirebaseAuth.js', () => ({
  firebaseAuth: { onAuthStateChanged() {} }
}));

import { UIManager } from '../public/js/ui/UIManager.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('YouTube search queue UI', () => {
  it('renders queue updates into the local queue list', () => {
    vi.useFakeTimers();
    const queueList = { innerHTML: 'initial' };
    const queueBadge = { innerText: 'initial' };
    const documentStub = {
      getElementById(id) {
        if (id === 'queueListContainer') return queueList;
        if (id === 'queueCountBadge') return queueBadge;
        return null;
      },
      addEventListener() {}
    };
    vi.stubGlobal('document', documentStub);
    vi.stubGlobal('window', { addEventListener() {} });

    const ui = new UIManager({ audioEngine: { onPlaybackEnded: null } });
    ui.init();
    ui.renderQueue([]);

    expect(queueList.innerHTML).toContain('Antrean kosong');
    expect(queueBadge.innerText).toBe('0 lagu');
  });
});
