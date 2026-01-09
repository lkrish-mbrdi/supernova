import { TokenTheme } from "@supernovaio/sdk-exporters"
import { getLogger } from "..";

export interface XcodeTheme {
  readonly name: string;
  readonly lightTheme?: TokenTheme;
  readonly darkTheme?: TokenTheme;
}

type ThemeVariant = "light" | "dark";

function getThemeVariant(name: string): ThemeVariant | undefined {
  const normalized = name.trim().toLowerCase();
  if (/\blight\b$/.test(normalized)) {
    return "light";
  }
  if (/\bdark\b$/.test(normalized)) {
    return "dark";
  }
  return undefined;
}

function deriveBaseThemeName(name: string, _variant?: ThemeVariant): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return trimmed;
  }

  const [base] = trimmed.split(/\s+/);
  return base ?? trimmed;
}


type ThemeVariantMap = Partial<Record<ThemeVariant, TokenTheme>>;

function createThemeGroup(name: string, variants: ThemeVariantMap): XcodeTheme {
  return {
    name,
    lightTheme: variants.light,
    darkTheme: variants.dark,
  };
}

export function groupThemes(themes: Array<TokenTheme>): Array<XcodeTheme> {
  if (themes.length === 0) {
    return [];
  }

  const logger = getLogger();
  const groups = new Map<string, ThemeVariantMap>();

  for (const t of themes) {
    const variant = getThemeVariant(t.name);
    if (!variant) {
      logger.log(`Skipping theme '${t.name}' because no light/dark suffix was detected.`);
      continue;
    }

    const base = deriveBaseThemeName(t.name, variant);
    const entry = groups.get(base) ?? {};

    if (entry[variant]) {
      logger.log(`Duplicate ${variant} theme found for base '${base}'. Replacing existing theme.`);
    }

    entry[variant] = t;
    groups.set(base, entry);
  }

  const result: Array<XcodeTheme> = [];
  for (const [base, pair] of groups) {
    if (pair.light || pair.dark) {
      result.push(createThemeGroup(base, pair));
    }
  }
  return result;
}
