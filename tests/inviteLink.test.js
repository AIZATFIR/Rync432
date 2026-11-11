import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../public/js/ui/UIManager.js', () => ({ UIManager: class {} }));
vi.stubGlobal('window', { addEventListener: vi.fn() });
const { joinRoomFromInvite } = await import('../public/js/app.js');

afterEach(() => vi.unstubAllGlobals());

describe('room invite links', () => {
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
});
