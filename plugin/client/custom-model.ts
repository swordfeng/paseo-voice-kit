// Building the saved record for a model added in the form (pure, no React).
import type { CustomModel } from "../shared/settings";

/** An id fragment from a name: ASCII letters and digits (accents dropped), "model" if none. */
function slug(text: string): string {
  const ascii = text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return ascii.replace(/[^a-z0-9]+/g, "-").slice(0, 32).replace(/^-+|-+$/g, "") || "model";
}

/** The form's values once resolved: everything but the id, optional fields possibly empty. */
export type Draft = Omit<Partial<CustomModel>, "id" | "kind" | "source" | "label"> & Pick<CustomModel, "kind" | "source" | "label">;

/**
 * The model to save: a new valid id, trimmed text, and no empty or undefined fields (Paseo's
 * settings must be plain JSON, and the settings schema rejects an invalid id).
 */
export function customModelFromDraft(draft: Draft): CustomModel {
  const label = draft.label.trim();
  const suffix = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  const model: Record<string, unknown> = { id: `custom-${slug(label)}-${suffix}`, label, kind: draft.kind, source: draft.source };
  for (const [key, value] of Object.entries(draft)) {
    if (key in model || value === undefined || value === null) continue;
    const v = typeof value === "string" ? value.trim() : value;
    if (v === "") continue;
    model[key] = key === "sha256" && typeof v === "string" ? v.toLowerCase() : v;
  }
  return model as CustomModel;
}
