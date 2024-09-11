import path from "path";
import * as fs from "fs";
import * as chokidar from "chokidar";
import { globbySync } from "globby";
import { parse } from "vue-docgen-api";
import { mkdirp } from "mkdirp";
import _ from "lodash-es";

export default async function build(config) {
  config.componentsRoot = path.resolve(config.cwd, config.componentsRoot);
  config.outFile = path.resolve(config.cwd, config.outFile);

  // then create the watcher if necessary
  const { watcher, componentFiles } = getSources(config.components, config.componentsRoot);

  // eslint-disable-next-line no-console
  console.log("Building web-types to " + config.outFile);

  const cache = {};
  const buildWebTypesBound = rebuild.bind(null, config, componentFiles, cache, watcher);

  try {
    await buildWebTypesBound();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("Error building web-types: " + e.message);
    await watcher.close();

    return;
  }

  if (config.watch) {
    watcher
      .on("add", buildWebTypesBound)
      .on("change", buildWebTypesBound)
      .on("unlink", async (filePath) => {
        // eslint-disable-next-line no-console
        console.log("Rebuilding on file removal " + filePath);
        delete cache[filePath];
        await writeDownWebTypesFile(config, Object.values(cache), config.outFile);
      });
  } else {
    await watcher.close();
  }
}

function getSources(components, cwd) {
  const watcher = chokidar.watch(components, { cwd });

  const allComponentFiles = globbySync(components, { cwd });

  return { watcher, componentFiles: allComponentFiles };
}

async function rebuild(config, files, cachedContent, watcher, changedFilePath) {
  const cacheWebTypesContent = async (filePath) => {
    cachedContent[filePath.replace(/\\/g, "/")] = await extractInformation(
      path.join(config.componentsRoot, filePath),
      config,
    );

    return true;
  };

  if (changedFilePath) {
    // eslint-disable-next-line no-console
    console.log("Rebuilding on update file " + changedFilePath);

    try {
      // if in chokidar mode (watch), the path of the file that was just changed
      // is passed as an argument. We only affect the changed file and avoid re-parsing the rest
      await cacheWebTypesContent(changedFilePath);
    } catch (e) {
      throw new Error(
        `Error building file ${config.outFile} when file ${changedFilePath} has changed: ${e.message}`,
      );
    }
  } else {
    try {
      // if we are initializing the current file, parse all components
      await Promise.all(files.map(cacheWebTypesContent));
    } catch (e) {
      throw new Error(`Error building file ${config.outFile}: ${e.message}`);
    }
  }

  // and finally save all concatenated values to the markdown file
  await writeDownWebTypesFile(config, Object.values(cachedContent), config.outFile);
}

async function writeDownWebTypesFile(config, definitions, destFilePath) {
  const destFolder = path.dirname(destFilePath);

  await mkdirp(destFolder);
  let writeStream = fs.createWriteStream(destFilePath);
  const contents = {
    framework: "vue",
    name: config.packageName,
    version: config.packageVersion,
    contributions: {
      html: {
        "description-markup": config.descriptionMarkup,
        "types-syntax": config.typesSyntax,
        tags: _(definitions)
          .flatMap((d) => d.tags || [])
          .orderBy("name", "asc")
          .value(),
        attributes: _(definitions)
          .flatMap((d) => d.attributes || [])
          .orderBy("name", "asc")
          .value(),
        "vue-filters": _(definitions)
          .flatMap((d) => d["vue-filters"] || [])
          .orderBy("name", "asc")
          .value(),
      },
    },
  };

  const html = contents.contributions.html;

  if (html.tags?.length == 0) html.tags = undefined;
  if (html.attributes?.length == 0) html.attributes = undefined;
  if (html["vue-filters"]?.length == 0) html["vue-filters"] = undefined;

  writeStream.write(JSON.stringify(contents, null, 2));

  // close the stream
  writeStream.close();
}

function ensureRelative(path) {
  // The .replace() is a fix for paths that end up like "./src\\components\\General\\VerticalButton.vue" on windows machines.
  return (path.startsWith("./") || path.startsWith("../") ? path : "./" + path).replace(/\\/g, "/");
}

async function extractInformation(absolutePath, config) {
  const doc = await parse(absolutePath, config.apiOptions);
  const name = doc.name || doc.displayName;
  let description = doc.description?.trim() ?? "";

  // Get default component and global config paths
  const defaultConfigPath = path.join(path.dirname(absolutePath), "config.js");
  const globalConfigPath = path.join(config.cwd, "vueless.config.js");

  // Import files as a modules
  const defaultConfigModule = fs.existsSync(defaultConfigPath) && (await import(defaultConfigPath));
  const globalConfigModule = fs.existsSync(globalConfigPath) && (await import(globalConfigPath));
  const globalConfigComponents = globalConfigModule?.default?.component || {};

  const defaults = _.merge(
    defaultConfigModule?.default?.defaults || {},
    globalConfigComponents[name]?.defaults || {},
  );

  doc.docsBlocks?.forEach((block) => {
    if (description.length > 0) {
      if (config.descriptionMarkup === "html") {
        description += "<br/><br/>";
      } else {
        description += "\n\n";
      }
    }

    description += block;
  });

  const componentPath = ensureRelative(path.relative(config.cwd, absolutePath));
  // Prevent "Chose declaration" duplication issue in Intellij
  const source = !componentPath.includes("vueless")
    ? { source: { module: componentPath, symbol: doc.exportName } }
    : {};

  return {
    tags: [
      {
        name,
        description,
        attributes: doc.props?.map((prop) => ({
          name: prop.name,
          required: prop.required,
          description: prop.tags?.ignore ? "@ignore: " + prop.description : prop.description,
          value: {
            kind: "expression",
            type: prop.values ? `'${prop.values.join("' | '")}'` : prop.type?.name ?? "any",
          },
          default:
            defaults && prop.name in defaults
              ? defaults[prop.name]?.toString()
              : prop.defaultValue?.value?.toString(),
        })),
        events: doc.events?.map((event) => ({
          name: event.name,
          description: event.description,
          properties: event.properties?.map((property) => ({
            type: property.type?.names,
            name: property.name,
            description: property.description,
          })),
        })),
        slots: doc.slots?.map((slot) => ({
          name: slot.name,
          scoped: slot.scoped,
          description: slot.description,
          bindings: slot.bindings?.map((binding) => ({
            type: binding.type?.name,
            name: binding.name,
            description: binding.description,
          })),
        })),
        ...source,
      },
    ],
  };
}
