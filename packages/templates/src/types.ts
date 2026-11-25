import type { AssetManifest, ConfigParam, GameConfigValues, GameSpec } from "@aa-game/protocol";

export interface TemplateProject {
  id: string;
  name: string;
  tagline: string;
  spec: GameSpec;
  configSchema: ConfigParam[];
  defaultConfig: GameConfigValues;
  assets: AssetManifest;
  files: Record<string, string>;
}

export function getDefaultConfigValues(schema: ConfigParam[]): GameConfigValues {
  const out: GameConfigValues = {};
  for (const item of schema) {
    out[item.key] = item.defaultValue;
  }
  return out;
}
