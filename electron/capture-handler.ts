import type { CapturedViewport } from './capture-types';

interface FrameLike {}
interface SenderLike { id: number; mainFrame: FrameLike }
interface CaptureEventLike { sender: SenderLike; senderFrame: FrameLike | null }
interface NativeImageLike {
  isEmpty(): boolean;
  getScaleFactors(): number[];
  toPNG(options: { scaleFactor: number }): Buffer;
}
interface SenderWindowLike {
  isDestroyed(): boolean;
  webContents: { capturePage(): Promise<NativeImageLike> };
}
interface CaptureDependencies {
  isAuthorized(sender: SenderLike): boolean;
  fromWebContents(sender: SenderLike): SenderWindowLike | null;
}

export function createCaptureViewportHandler({ isAuthorized, fromWebContents }: CaptureDependencies) {
  return async (event: CaptureEventLike): Promise<CapturedViewport> => {
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Burn capture requests must come from the main frame');
    }
    if (!isAuthorized(event.sender)) throw new Error('Burn capture sender is not authorized');
    const window = fromWebContents(event.sender);
    if (!window || window.isDestroyed()) throw new Error('Burn capture window unavailable');

    const image = await window.webContents.capturePage();
    if (image.isEmpty()) throw new Error('Burn capture returned an empty image');
    const scaleFactor = Math.max(
      1,
      ...image.getScaleFactors().filter((value) => Number.isFinite(value) && value > 0),
    );
    const png = image.toPNG({ scaleFactor });
    if (png.byteLength === 0) throw new Error('Burn capture returned an empty PNG');
    return {
      png: new Uint8Array(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength)),
      scaleFactor,
    };
  };
}
