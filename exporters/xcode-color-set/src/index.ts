import { Supernova, PulsarContext, TokenGroup, RemoteVersionIdentifier, AnyOutputFile, OutputTextFile, Token, TokenType, TokenTheme } from "@supernovaio/sdk-exporters"
import { ThemeHelper, StringCase, TokenNameTracker, WriteTokenPropStore, NamingHelper, FileHelper } from "@supernovaio/export-utils"
import { createCatalogRootFile, createPerTokenFile } from "./files/color-sets"
import { ExporterConfiguration } from "../config"
import { groupThemes, XcodeTheme } from "./files/xcode-theme"

/**
 * Xcode Color Set Exporter (Proof of Concept)
 *
 * What this exporter does:
 * - Reads color tokens from the current design system version
 * - Optionally applies selected themes to compute themed values per token
 * - Generates an Xcode asset catalog with one color set per color token
 * - Each color set file (Contents.json) is an object with:
 *   - A "colors" array containing:
 *     - One base entry (universal)
 *     - One themed entry marked as { appearances: [{ appearance: "luminosity", value: "dark" }] }
 *   - An "info" object with version and author metadata
 *
 * Theme application rules (per request):
 * - If there is only 1 selected theme: apply it as dark appearance (single themed entry)
 * - If there are 2+ selected themes: apply the FIRST theme to the base value and the SECOND theme
 *   as dark appearance; ignore any other themes
 *
 * Output location options:
 * - generateRootCatalog (boolean): when true, create the root catalog folder and its Contents.json
 * - rootCatalogPath (string): root path for the catalog; can include "/" to create nested folders
 */
export const exportConfiguration = Pulsar.exportConfig<ExporterConfiguration>()

class Logger {
  private file: OutputTextFile

  constructor(rootPath: string) {
    this.file = FileHelper.createTextFile({
      relativePath: rootPath ? `./${rootPath}/` : ``,
      fileName: "log.txt",
      content: "",
    })
  }

  getFile(): OutputTextFile {
    return this.file
  }

  log(message: string) {
    const line = String(message)
    this.file.content = this.file.content ? `${this.file.content}\n${line}` : line
  }
}

// Lazily-initialized global logger singleton
let globalLogger: Logger | null = null
export function getLogger(rootPath: string = ""): Logger {
  if (!globalLogger) {
    globalLogger = new Logger(rootPath)
  }
  return globalLogger
}

Pulsar.export(async (sdk: Supernova, context: PulsarContext): Promise<Array<AnyOutputFile>> => {
  // Prepare output files and, depending on configuration, prepare root path/file
  const files: Array<AnyOutputFile> = []
  const rootPath = resolveRootPath()

  // Initialize global logger (creates log.txt once)
  const logger = getLogger(rootPath)
  files.push(logger.getFile())

  // Step-by-step progress
  logger.log(`Exporter: Xcode Color Set`)
  logger.log(`Started: ${new Date().toISOString()}`)
  logger.log(`Design System ID: ${context.dsId}`)
  logger.log(`Version ID: ${context.versionId}`)
  logger.log(`Brand ID: ${context.brandId ?? '-'}`)
  // Identify which design system + version we are exporting from
  const remoteVersionIdentifier: RemoteVersionIdentifier = {
    designSystemId: context.dsId,
    versionId: context.versionId,
  }

  const filter = {brandId: context.brandId ?? undefined};

  // Fetch tokens, token groups, and token collections from the selected design system version
  const { tokens, tokenGroups, tokenCollections } = await loadTokenData(sdk, remoteVersionIdentifier, filter)
  logger.log(`Fetched tokens: ${tokens.length}`)
  logger.log(`Fetched token groups: ${tokenGroups.length}`)
  logger.log(`token groups: ${tokenGroups.slice(0,5).map(g => g.name).join(', ')}${tokenGroups.length > 5 ? ', ...' : ''}`);
  logger.log(`Fetched collections: ${tokenCollections.length}`)
  logger.log(`token collections: ${tokenCollections.map(g => g.name).join(', ')}`);


  // Only color tokens are relevant for Xcode color sets
  let colorTokens = tokens.filter((t) => t.tokenType === TokenType.color)
  logger.log(`Filtered color tokens: ${colorTokens.length}`)

  // Resolve selected themes (if any)
  let themesToApply: Array<TokenTheme> = []
  if (context.themeIds && context.themeIds.length > 0) {
    const themes = await sdk.tokens.getTokenThemes(remoteVersionIdentifier)
    themesToApply = context.themeIds.map((themeId) => {
      const theme = themes.find((t) => t.id === themeId || t.idInVersion === themeId)
      if (!theme) {
        throw new Error(`Unable to find theme ${themeId}`)
      }
      return theme
    })
    logger.log(`Resolved themes: ${themesToApply.map(t => ThemeHelper.getThemeName(t)).join(', ') || '-'}`)
  } else {
    logger.log(`Resolved themes: none`)
  }

  // Filter out tokens from excluded collections
  colorTokens = filterExcludedCollections(colorTokens, tokenCollections, logger)

  if (exportConfiguration.generateRootCatalog) {
    files.push(createCatalogRootFile(rootPath))
    logger.log(`Created root catalog: ${rootPath}`)
  } else {
    logger.log(`Root catalog generation disabled`)
  }

  const groupedThemes = groupThemes(themesToApply)
  logGroupedThemes(logger, groupedThemes)

  const exportContext: ExportContext = {
    sdk,
    pulsarContext: context,
    remoteVersionIdentifier,
    logger,
    rootPath,
    exportConfiguration,
    tokens,
    tokenGroups,
    colorTokens,
  }

  for (const themeGroup of groupedThemes) {
    const namespaceFiles = await exportThemeGroup(exportContext, themeGroup)
    files.push(...namespaceFiles)
  }

  // Return all files to the export engine for writing to the destination
  return files
})


async function createThemeColors(
  runtime: ExportContext,
  colorsPath: string,
  lightTheme: TokenTheme,
  darkTheme?: TokenTheme,
): Promise<Array<AnyOutputFile>> {
  const { sdk, tokens, tokenGroups, exportConfiguration, colorTokens, remoteVersionIdentifier, pulsarContext, logger } = runtime

  const created: Array<AnyOutputFile> = []

  // Theme application strategy
  // - 0 themes: base only
  // - 1 theme: base + dark (apply that one theme)
  // - 2+ themes: base is computed by applying the FIRST theme; dark is computed by applying the SECOND theme
  const baseTokens = computeTokensForTheme(sdk, tokens, lightTheme)
  const darkTokens = computeTokensForTheme(sdk, tokens, darkTheme)

  logger.log(`Applied base theme: ${ThemeHelper.getThemeName(lightTheme)}`)
  logger.log(`Applied dark theme: ${darkTheme ? ThemeHelper.getThemeName(darkTheme) : 'none'}`)

  // Create lookup maps by token id for base and dark values
  const baseById = new Map<string, Token>(baseTokens.map((t) => [t.id, t]))
  const darkById = new Map<string, Token>(darkTokens.map((t) => [t.id, t]))

  // Use tracker + configured style for folder naming
  const tracker = new TokenNameTracker()
  const nameStyle = exportConfiguration.folderNameStyle || StringCase.kebabCase

  // Emit one file per color token according to rules above
  for (const token of colorTokens) {
    const baseToken = baseById.get(token.id) || token
    const darkVariant = darkById.get(token.id)
    const variants = darkVariant ? [darkVariant] : []
    const file = createPerTokenFile(baseToken, tokenGroups, colorsPath, variants, tracker, nameStyle)
    if (file) {
      created.push(file)
    }
  }
  logger.log(`Emitted color set files: ${colorTokens.length}`)

  // Optional write-back of folder names to tokens as a custom property
  if (exportConfiguration.writeNameToProperty && !(pulsarContext as any).isPreview) {
    const writeStore = new WriteTokenPropStore(sdk, remoteVersionIdentifier)
    await writeStore.writeTokenProperties(exportConfiguration.propertyToWriteNameTo, colorTokens, (t) => {
      // Use tracker+style to mirror exported folder names
      const name = tracker.getTokenName(t, tokenGroups, nameStyle, null, true)
      return NamingHelper.codeSafeVariableName(name, nameStyle)
    })
    logger.log(`Wrote exported names to property: ${exportConfiguration.propertyToWriteNameTo}`)
  } else {
    logger.log(`Write-back disabled or preview mode`)
  }

  // Log final counts and finish
  const themedVariantCount = colorTokens.filter((t) => darkById.has(t.id)).length
  logger.log(`Dark variants generated: ${themedVariantCount}`)

  return created
}

function createNameSpaceFolder(name: string, rootPath: string) {
  const content = JSON.stringify({ 
    info: { version: 1, author: "xcode" },
    properties: { 'provides-namespace' : true }
  }, null, 2)

  return FileHelper.createTextFile({
    relativePath: rootPath ? `./${rootPath}/${name}` : `./${name}`,
    fileName: "Contents.json",
    content
  })
}

function resolveRootPath(): string {
  if (!exportConfiguration.generateRootCatalog) {
    return ""
  }
  return exportConfiguration.rootCatalogPath || "Colors.xcassets"
}

async function loadTokenData(
  sdk: Supernova,
  remoteVersionIdentifier: RemoteVersionIdentifier,
  filter: { brandId?: string }
) {
  const [tokens, tokenGroups, tokenCollections] = await Promise.all([
    sdk.tokens.getTokens(remoteVersionIdentifier, filter),
    sdk.tokens.getTokenGroups(remoteVersionIdentifier, filter),
    sdk.tokens.getTokenCollections(remoteVersionIdentifier),
  ])

  return { tokens, tokenGroups, tokenCollections }
}

function filterExcludedCollections(
  colorTokens: Array<Token>,
  tokenCollections: Array<{ persistentId: string; name: string }>,
  logger: Logger
): Array<Token> {
  if (!exportConfiguration.excludeCollectionsInPipelines || exportConfiguration.excludedCollections.length === 0) {
    logger.log(`Excluded collections enabled: no`)
    return colorTokens
  }

  const originalCount = colorTokens.length
  const excludedCollectionNames = new Set(
    exportConfiguration.excludedCollections.map((name) => name.toLowerCase().trim())
  )

  const filtered = colorTokens.filter((token) => {
    const tokenCollection = tokenCollections.find((c) => c.persistentId === token.collectionId)
    if (!tokenCollection) {
      return true
    }
    return !excludedCollectionNames.has(tokenCollection.name.toLowerCase().trim())
  })

  logger.log(`Excluded collections enabled: yes`)
  logger.log(`Excluded collections: ${exportConfiguration.excludedCollections.join(', ')}`)
  logger.log(`Color tokens after exclusions: ${filtered.length} (was ${originalCount})`)

  return filtered
}

function logGroupedThemes(logger: Logger, groupedThemes: Array<XcodeTheme>) {
  if (groupedThemes.length === 0) {
    logger.log(`Grouped themes: none`)
    return
  }

  const items = groupedThemes
    .map((group) => {
      const light = group.lightTheme ? ThemeHelper.getThemeName(group.lightTheme) : '-'
      const dark = group.darkTheme ? ThemeHelper.getThemeName(group.darkTheme) : '-'
      return `${group.name} (light: ${light}, dark: ${dark})`
    })
    .join('; ')

  logger.log(`Grouped themes (${groupedThemes.length}): ${items}`)
}

async function exportThemeGroup(runtime: ExportContext, group: XcodeTheme): Promise<Array<AnyOutputFile>> {
  const { logger, rootPath } = runtime

  logger.log(`Grouped theme: ${group.name}, light: ${group.lightTheme ? 'yes' : 'no'}, dark: ${group.darkTheme ? 'yes' : 'no'}`)
  logger.log(`Root path for theme: ${rootPath || '-'}`)

  const themeName = NamingHelper.codeSafeVariableName(group.name, StringCase.pascalCase)
  const namespaceFile = createNameSpaceFolder(themeName, rootPath)
  logger.log(`Created namespace folder for theme: ${namespaceFile.path}/${namespaceFile.name}`)

  if (!group.lightTheme) {
    logger.log(`Skipped color generation for ${group.name} because no light theme variant was provided.`)
    return [namespaceFile]
  }

  const colorsPath = rootPath ? `${rootPath}/${themeName}` : `${themeName}`
  logger.log(`Colors path: ${colorsPath}`)

  const createdFiles = await createThemeColors(runtime, colorsPath, group.lightTheme, group.darkTheme)

  return [namespaceFile, ...createdFiles]
}

function computeTokensForTheme(
  sdk: Supernova,
  tokens: Array<Token>,
  theme?: TokenTheme
): Array<Token> {
  if (!theme) {
    return []
  }
  return sdk.tokens.computeTokensByApplyingThemes(tokens, tokens, [theme])
}

type ExportContext = {
  sdk: Supernova
  pulsarContext: PulsarContext
  remoteVersionIdentifier: RemoteVersionIdentifier
  logger: Logger
  rootPath: string
  exportConfiguration: ExporterConfiguration
  tokens: Array<Token>
  tokenGroups: Array<TokenGroup>
  colorTokens: Array<Token>
}
