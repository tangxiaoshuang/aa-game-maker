export * from "./types.js";
export * from "./neon-dodger.js";
export * from "./star-dash-arena.js";

import { neonDodgerTemplate } from "./neon-dodger.js";
import { starDashArenaTemplate } from "./star-dash-arena.js";
import type { TemplateProject } from "./types.js";

export const BUILTIN_TEMPLATES: TemplateProject[] = [
  neonDodgerTemplate,
  starDashArenaTemplate,
];

export function getTemplateById(id: string): TemplateProject | undefined {
  return BUILTIN_TEMPLATES.find((t) => t.id === id);
}
