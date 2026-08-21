import { describe, expect, it, vi } from 'vitest';
import { createCaptureViewportHandler } from '../../electron/capture-handler';

function event(mainFrame = true) {
  const frame = {};
  return {
    sender: { id: 7, mainFrame: frame },
    senderFrame: mainFrame ? frame : {},
  };
}

const authorize = () => true;

describe('createCaptureViewportHandler', () => {
  it('rejects subframe callers', async () => {
    const handler = createCaptureViewportHandler({ isAuthorized: authorize, fromWebContents: vi.fn() });
    await expect(handler(event(false) as never)).rejects.toThrow('main frame');
  });

  it('rejects a main-frame sender that was not registered by the app', async () => {
    const fromWebContents = vi.fn();
    const handler = createCaptureViewportHandler({
      isAuthorized: () => false,
      fromWebContents,
    });
    await expect(handler(event() as never)).rejects.toThrow('not authorized');
    expect(fromWebContents).not.toHaveBeenCalled();
  });

  it('captures only the sender window and returns PNG bytes', async () => {
    const png = Buffer.from([137, 80, 78, 71]);
    const toPNG = vi.fn(() => png);
    const capturePage = vi.fn().mockResolvedValue({
      isEmpty: () => false,
      getScaleFactors: () => [1, 2],
      toPNG,
    });
    const senderWindow = {
      isDestroyed: () => false,
      webContents: { capturePage },
    };
    const handler = createCaptureViewportHandler({
      isAuthorized: authorize,
      fromWebContents: vi.fn().mockReturnValue(senderWindow),
    });

    const result = await handler(event(true) as never);

    expect(capturePage).toHaveBeenCalledOnce();
    expect(result.scaleFactor).toBe(2);
    expect(toPNG).toHaveBeenCalledWith({ scaleFactor: 2 });
    expect([...result.png]).toEqual([...png]);
  });

  it('rejects a missing, destroyed, or empty sender window', async () => {
    const missing = createCaptureViewportHandler({
      isAuthorized: authorize,
      fromWebContents: () => null,
    });
    await expect(missing(event() as never)).rejects.toThrow('window unavailable');

    const empty = createCaptureViewportHandler({
      isAuthorized: authorize,
      fromWebContents: () => ({
        isDestroyed: () => false,
        webContents: {
          capturePage: async () => ({
            isEmpty: () => true,
            getScaleFactors: () => [1],
            toPNG: () => Buffer.alloc(0),
          }),
        },
      }),
    });
    await expect(empty(event() as never)).rejects.toThrow('empty image');

    const emptyPng = createCaptureViewportHandler({
      isAuthorized: authorize,
      fromWebContents: () => ({
        isDestroyed: () => false,
        webContents: {
          capturePage: async () => ({
            isEmpty: () => false,
            getScaleFactors: () => [1],
            toPNG: () => Buffer.alloc(0),
          }),
        },
      }),
    });
    await expect(emptyPng(event() as never)).rejects.toThrow('empty PNG');
  });
});
