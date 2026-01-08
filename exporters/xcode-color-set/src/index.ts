import { Supernova, PulsarContext, TokenGroup, RemoteVersionIdentifier, AnyOutputFile, OutputTextFile, Token, TokenType, TokenTheme } from "@supernovaio/sdk-exporters"
import { ThemeHelper, StringCase, TokenNameTracker, WriteTokenPropStore, NamingHelper, FileHelper } from "@supernovaio/export-utils"
import { createCatalogRootFile, createPerTokenFile } from "./files/color-sets"
import { ExporterConfiguration } from "../config"
import { groupThemes } from "./files/xcode-theme"

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
  const rootPath = exportConfiguration.generateRootCatalog ? (exportConfiguration.rootCatalogPath || "Colors.xcassets") : ""

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
  let tokens = await sdk.tokens.getTokens(remoteVersionIdentifier, filter)
  let tokenGroups = await sdk.tokens.getTokenGroups(remoteVersionIdentifier, filter)
  let tokenCollections = await sdk.tokens.getTokenCollections(remoteVersionIdentifier)
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
  if (exportConfiguration.excludeCollectionsInPipelines && 
      exportConfiguration.excludedCollections.length > 0) {
    
    const originalCount = colorTokens.length
    
    // Create a set of excluded collection names (lowercase) for efficient lookup
    const excludedCollectionNames = new Set(
      exportConfiguration.excludedCollections.map(name => name.toLowerCase().trim())
    )
    
    // Filter tokens based on their collectionId
    colorTokens = colorTokens.filter((token) => {
      // Find the collection this token belongs to
      const tokenCollection = tokenCollections.find(c => c.persistentId === token.collectionId)
      
      // Exclude if the collection name matches any excluded collection (case-insensitive)
      if (tokenCollection && excludedCollectionNames.has(tokenCollection.name.toLowerCase().trim())) {
        return false // Exclude this token
      }
      
      return true // Keep this token
    })
    logger.log(`Excluded collections enabled: yes`)
    logger.log(`Excluded collections: ${exportConfiguration.excludedCollections.join(', ')}`)
    logger.log(`Color tokens after exclusions: ${colorTokens.length} (was ${originalCount})`)
  } else {
    logger.log(`Excluded collections enabled: no`)
  }

  if (exportConfiguration.generateRootCatalog) {
    files.push(createCatalogRootFile(rootPath))
    logger.log(`Created root catalog: ${rootPath}`)
  } else {
    logger.log(`Root catalog generation disabled`)
  }

  const groupedThemes = groupThemes(themesToApply);
  logger.log(`Grouped themes: (${groupedThemes.length}) ${groupedThemes}`);
  groupedThemes.forEach(async t => {
    logger.log(`Grouped theme: ${t.name}, light: ${t.lightTheme ? 'yes' : 'no'}, dark: ${t.darkTheme ? 'yes' : 'no'}`);

    logger.log('Root path for theme: ' + rootPath);
    const themeName = NamingHelper.codeSafeVariableName(t.name, StringCase.pascalCase);
    const file = createNameSpaceFolder(themeName, rootPath);
    files.push(file);
    logger.log('Created namespace folder for theme: ' + file.path + '/' + file.name);
    
    if (t.lightTheme) {

      const path = rootPath ? `${rootPath}/${themeName}` : `${themeName}`;
      logger.log(`colors path: ${path}`);
      
      const createdFiles = await createThemeColors(
        sdk, context, remoteVersionIdentifier,
        path,
        tokens, tokenGroups, exportConfiguration, 
        colorTokens,
        t.lightTheme, t.darkTheme
    );
      files.push(...createdFiles);
    }
  });

  // Return all files to the export engine for writing to the destination
  return files
})


async function createThemeColors(
  sdk: Supernova,
  context: PulsarContext,
  remoteVersionIdentifier: RemoteVersionIdentifier,
  rootPath: string,
  tokens: Array<Token>,
  tokenGroups: Array<TokenGroup>,
  exportConfiguration: ExporterConfiguration,
  colorTokens: Array<Token>,
  lightTheme: TokenTheme,
  darkTheme?: TokenTheme,
): Promise<Array<AnyOutputFile>> {
  const logger = getLogger();

  const created: Array<AnyOutputFile> = []
    
  
  // Theme application strategy
  // - 0 themes: base only
  // - 1 theme: base + dark (apply that one theme)
  // - 2+ themes: base is computed by applying the FIRST theme; dark is computed by applying the SECOND theme
  let baseTokens: Array<Token> = tokens
  let darkTokens: Array<Token> = []

  baseTokens = lightTheme ? sdk.tokens.computeTokensByApplyingThemes(tokens, tokens, [lightTheme]) : []
  darkTokens = darkTheme ? sdk.tokens.computeTokensByApplyingThemes(tokens, tokens, [darkTheme]) : []
  logger.log(`Applied base theme: ${ThemeHelper.getThemeName(lightTheme!)}`)
  logger.log(`Applied dark theme: ${ darkTheme ? ThemeHelper.getThemeName(darkTheme) : 'none' }`)

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
    const file = createPerTokenFile(baseToken, tokenGroups, rootPath, variants, tracker, nameStyle)
    if (file) {
      created.push(file)
    }
  }
  logger.log(`Emitted color set files: ${colorTokens.length}`)

  // Optional write-back of folder names to tokens as a custom property
  if (exportConfiguration.writeNameToProperty && !(context as any).isPreview) {
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
