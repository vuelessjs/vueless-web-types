import path from "path";
import fs from "fs";
import { readFile } from "fs/promises";

export async function extractConfig(cwd, watch = false, configFileFromCmd, pathArray = []) {
  const configFilePath = configFileFromCmd
    ? path.resolve(cwd, configFileFromCmd)
    : path.join(cwd, "web-types.config.js");
  const [componentsFromCmd, outFileFromCmd] = pathArray;

  const fileContent = await readFile(path.join(cwd, "package.json"), "utf-8");
  const packageJson = JSON.parse(fileContent);

  let additionalConfig = {};

  if (fs.existsSync(configFilePath)) {
    additionalConfig = await import(configFilePath);
  }

  const components = additionalConfig.default?.isVuelessEnv
    ? ["src/**/*.vue", componentsFromCmd]
    : ["node_modules/vueless/**/*.vue", "src/components/**/*.vue", componentsFromCmd];

  return {
    cwd,
    watch,
    componentsRoot: configFilePath ? path.dirname(configFilePath) : cwd,
    components,
    outFile: outFileFromCmd || packageJson["web-types"] || "./web-types.json",
    packageName: packageJson["name"],
    packageVersion: packageJson["version"],
    typesSyntax: "typescript",
    descriptionMarkup: "markdown",
    ...additionalConfig.default,
  };
}
