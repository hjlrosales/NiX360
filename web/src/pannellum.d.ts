/** Pannellum 2.5.7 ships as browser bundles without type declarations. */
declare module 'pannellum/build/pannellum.js';
declare module 'pannellum/build/pannellum.css';

type PannellumViewer = {
  destroy(): void;
  on(event: string, handler: (...args: unknown[]) => void): PannellumViewer;
  off(event?: string, handler?: (...args: unknown[]) => void): PannellumViewer;
  lookAt(pitch: number, yaw: number, hfov?: number, animated?: boolean): void;
  getYaw(): number;
  getPitch(): number;
  /** Pannellum animates over the given duration; 0 applies the value at once. */
  setYaw(yaw: number, duration?: number): PannellumViewer;
  setPitch(pitch: number, duration?: number): PannellumViewer;
  setHfov(hfov: number, duration?: number): PannellumViewer;
  getHfov(): number;
  getHfovBounds(): [number, number];
  isLoaded(): boolean;
  isOrientationSupported(): boolean;
  isOrientationActive(): boolean;
  startOrientation(): void;
  stopOrientation(): void;
  resize(): void;
};


interface Window {
  pannellum?: {
    viewer(container: HTMLElement | string, config: Record<string, unknown>): PannellumViewer;
  };
}
