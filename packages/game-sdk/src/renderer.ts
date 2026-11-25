import type { Application, Container } from "pixi.js";
import type { AssetManifest, GameConfigValues, GameEvent } from "@aa-game/protocol";
import type { ProceduralAudio } from "./audio.js";
import { lerp } from "./headless/math.js";

export interface RendererContext {
  app: Application;
  worldLayer: Container;
  hudLayer: Container;
  hudDomRoot: HTMLElement;
  worldSize: { width: number; height: number };
  localPlayerId: string;
  audio: ProceduralAudio;
  assets: AssetManifest;
  config: GameConfigValues;
  isMobile: boolean;
}

export interface GameRenderer<TState = unknown> {
  init(ctx: RendererContext): void | Promise<void>;
  render(state: TState, prevState: TState | null, alpha: number, ctx: RendererContext): void;
  onEvent?(event: GameEvent, ctx: RendererContext): void;
  destroy?(): void;
}

export function lerpPos(
  prev: { x: number; y: number } | undefined,
  curr: { x: number; y: number },
  alpha: number,
): { x: number; y: number } {
  if (!prev) return curr;
  return {
    x: lerp(prev.x, curr.x, alpha),
    y: lerp(prev.y, curr.y, alpha),
  };
}
