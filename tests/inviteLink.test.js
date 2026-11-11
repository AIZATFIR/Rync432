import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../public/js/ui/UIManager.js', () => ({ UIManager: class {} }));
vi.stubGlobal('window', { addEventListener: vi.fn() });
const { joinRoomFromInvite, updateRoomUrl } = await import('../public/js/app.js');

afterEach(() => vi.unstubAllGlobals());

describe('room invite links', () => {
  it('keeps the active room in the current URL for reload recovery', () => {
    const replaceState = vi.fn();
    vi.stubGlobal('window', {
      location: { href: 'https://rync.test/?from=invite#player' },
      history: { state: { scroll: 1 }, replaceState }
    });

    updateRoomUrl('ABCD');

    expect(replaceState).toHaveBeenCalledWith({ scroll: 1 }, '', '/?from=invite&room=ABCD#player');
  });

  it('removes the room from the URL after leaving while preserving other navigation state', () => {
    const replaceState = vi.fn();
    vi.stubGlobal('window', {
      location: { href: 'https://rync.test/?from=invite&room=ABCD#player' },
      history: { state: null, replaceState }
    });

    updateRoomUrl(null);

    expect(replaceState).toHaveBeenCalledWith(null, '', '/?from=invite#player');
  });

  it('consumes a rejected deep-link join so it cannot become an unhandled rejection', async () => {
    const socketClient = { joinRoom: vi.fn().mockRejectedValue(new Error('Room not found')) };

    await expect(joinRoomFromInvite(socketClient, 'ROOM', 'Guest')).resolves.toBeUndefined();
    expect(socketClient.joinRoom).toHaveBeenCalledWith('ROOM', 'Guest');
  });

  it('returns the room after a successful invite join', async () => {
    const room = { roomId: 'ROOM' };
    const socketClient = { joinRoom: vi.fn().mockResolvedValue(room) };

    await expect(joinRoomFromInvite(socketClient, 'ROOM', 'Guest')).resolves.toBe(room);
  });

  it('routes invite joins through the same visible room progress handler', async () => {
    const joinRoom = vi.fn().mockResolvedValue({ roomId: 'ROOM' });
    const uiManager = { joinRoom };

    await expect(joinRoomFromInvite({}, 'ROOM', 'Guest', uiManager)).resolves.toEqual({ roomId: 'ROOM' });

    expect(joinRoom).toHaveBeenCalledWith('ROOM');
  });
});
