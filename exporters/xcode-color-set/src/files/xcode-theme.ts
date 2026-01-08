import { TokenTheme } from "@supernovaio/sdk-exporters"
import { getLogger } from "..";

export class XcodeTheme {
    name: string;
    lightTheme?: TokenTheme;
    darkTheme?: TokenTheme;

    constructor(name: string, lightTheme?: TokenTheme, darkTheme?: TokenTheme) {
        this.name = name;
        this.lightTheme = lightTheme;
        this.darkTheme = darkTheme;
    }
}


function isLightThemeName(name: string): boolean {
  return /\slight\s*$/.test(name.toLowerCase());
}

function isDarkThemeName(name: string): boolean {
  return /\sdark\s*$/.test(name.toLowerCase());
}

function baseNameFromTheme(name: string): string {
  const trimmed = name.trim();
  const firstWord = trimmed.split(/\s+/)[0];
  const logger = getLogger();
  logger.log(`Base name from theme "${name}" is "${firstWord}"`);
  return firstWord;
}

export function groupThemes(themes: Array<TokenTheme>): Array<XcodeTheme> {
    const logger = getLogger();
    logger.log(`Grouping ${themes.length} themes`);
    const groups = new Map<string, { light?: TokenTheme; dark?: TokenTheme }>();

  for (const t of themes) {
    logger.log(`Processing theme: ${t.name}`);
    const base = baseNameFromTheme(t.name);
    const entry = groups.get(base) ?? {};
    if (isLightThemeName(t.name)) entry.light = t;
    else if (isDarkThemeName(t.name)) entry.dark = t;
    groups.set(base, entry);
    logger.log(`Processing theme: ${t.name}, base: ${base}, light: ${entry.light ? 'yes' : 'no'}, dark: ${entry.dark ? 'yes' : 'no'}`);
  }

    const result: Array<XcodeTheme> = [];
    for (const [base, pair] of groups) {
        logger.log(`Grouping theme base: ${base}, light: ${pair.light ? 'yes' : 'no'}, dark: ${pair.dark ? 'yes' : 'no'}`);
      if (pair.light || pair.dark) {
        result.push(new XcodeTheme(base, pair.light, pair.dark));
      }
    }
  return result;
}
