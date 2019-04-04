const fs = require('fs-extra')
const path = require('path')
const copy = require('copy-template-dir')
const { flags } = require('@oclif/command')
const Command = require('@netlify/cli-utils')
const inquirer = require('inquirer')
const { readRepoURL, validateRepoURL } = require('../../utils/readRepoURL')
const { createSiteAddon } = require('../../utils/addons')
const http = require('http')
const fetch = require('node-fetch')
const cp = require('child_process')
const { createAddon } = require('netlify/src/addons')

const templatesDir = path.resolve(__dirname, '../../functions-templates')

/**
 * Be very clear what is the SOURCE (templates dir) vs the DEST (functions dir)
 */
class FunctionsCreateCommand extends Command {
  async run() {
    const { flags, args } = this.parse(FunctionsCreateCommand)
    const { config } = this.netlify
    const functionsDir = ensureFunctionDirExists.call(this, flags, config)

    /* either download from URL or scaffold from template */
    if (flags.url) {
      await downloadFromURL.call(this, flags, args, functionsDir)
    } else {
      await scaffoldFromTemplate.call(this, flags, args, functionsDir)
    }
  }
}

FunctionsCreateCommand.args = [
  {
    name: 'name',
    description: 'name of your new function file inside your functions folder'
  }
]

FunctionsCreateCommand.description = `create a new function locally`

FunctionsCreateCommand.examples = [
  'netlify functions:create',
  'netlify functions:create hello-world',
  'netlify functions:create --name hello-world'
]
FunctionsCreateCommand.aliases = ['function:create']
FunctionsCreateCommand.flags = {
  name: flags.string({ char: 'n', description: 'function name' }),
  functions: flags.string({ char: 'f', description: 'functions folder' }),
  url: flags.string({ char: 'u', description: 'pull template from URL' })
  // // SWYX: deprecated; every scaffolded function is a directory now
  // dir: flags.boolean({
  //   char: 'd',
  //   description: 'create function as a directory'
  // })
}
module.exports = FunctionsCreateCommand

/**
 * all subsections of code called from the main logic flow above
 */

// prompt for a name if name not supplied
async function getNameFromArgs(args, flags, defaultName) {
  if (flags.name && args.name) throw new Error('function name specified in both flag and arg format, pick one')
  let name
  if (flags.name && !args.name) name = flags.name
  // use flag if exists
  else if (!flags.name && args.name) name = args.name

  // if neither are specified, prompt for it
  if (!name) {
    let responses = await inquirer.prompt([
      {
        name: 'name',
        message: 'name your function: ',
        default: defaultName,
        type: 'input',
        validate: val => !!val && /^[\w\-.]+$/i.test(val)
        // make sure it is not undefined and is a valid filename.
        // this has some nuance i have ignored, eg crossenv and i18n concerns
      }
    ])
    name = responses.name
  }
  return name
}

// pick template from our existing templates
async function pickTemplate() {
  // lazy loading on purpose
  inquirer.registerPrompt('autocomplete', require('inquirer-autocomplete-prompt'))
  const fuzzy = require('fuzzy')
  // doesnt scale but will be ok for now
  const [
    jsreg
    // tsreg, goreg
  ] = [
    'js'
    // 'ts', 'go'
  ].map(formatRegistryArrayForInquirer)
  const specialCommands = [
    new inquirer.Separator(`----[Special Commands]----`),
    {
      name: `*** Clone template from Github URL ***`,
      value: 'url',
      short: 'gh-url'
    },
    {
      name: `*** Report issue with, or suggest a new template ***`,
      value: 'report',
      short: 'gh-report'
    }
  ]
  const { chosentemplate } = await inquirer.prompt({
    name: 'chosentemplate',
    message: 'Pick a template',
    type: 'autocomplete',
    // suggestOnly: true, // we can explore this for entering URL in future
    source: async function(answersSoFar, input) {
      if (!input || input === '') {
        // show separators
        return [
          new inquirer.Separator(`----[JS]----`),
          ...jsreg,
          // new inquirer.Separator(`----[TS]----`),
          // ...tsreg,
          // new inquirer.Separator(`----[GO]----`),
          // ...goreg
          ...specialCommands
        ]
      } else {
        // only show filtered results sorted by score
        let ans = [
          ...filterRegistry(jsreg, input),
          // ...filterRegistry(tsreg, input),
          // ...filterRegistry(goreg, input)
          ...specialCommands
        ].sort((a, b) => b.score - a.score)
        return ans
      }
    }
  })
  return chosentemplate
  function filterRegistry(registry, input) {
    const temp = registry.map(x => x.name + x.description)
    const filteredTemplates = fuzzy.filter(input, temp)
    const filteredTemplateNames = filteredTemplates.map(x => (input ? x.string : x))
    // console.log({ filteredTemplateNames })
    return registry
      .filter(t => filteredTemplateNames.includes(t.name + t.description))
      .map(t => {
        // add the score
        const { score } = filteredTemplates.find(f => f.string === t.name + t.description)
        t.score = score
        return t
      })
  }
  function formatRegistryArrayForInquirer(lang) {
    const folderNames = fs.readdirSync(path.join(templatesDir, lang))
    const registry = folderNames
      .map(name => require(path.join(templatesDir, lang, name, '.netlify-function-template.js')))
      .sort((a, b) => (a.priority || 999) - (b.priority || 999))
      .map(t => {
        t.lang = lang
        return {
          // confusing but this is the format inquirer wants
          name: `[${t.name}] ` + t.description,
          value: t,
          short: lang + '-' + t.name
        }
      })
    return registry
  }
}

/* get functions dir (and make it if necessary) */
function ensureFunctionDirExists(flags, config) {
  const functionsDir = flags.functions || (config.build && config.build.functions)
  if (!functionsDir) {
    this.log('No functions folder specified in netlify.toml or as an argument')
    process.exit(1)
  }
  if (!fs.existsSync(functionsDir)) {
    this.log(`functions folder ${functionsDir} specified in netlify.toml but folder not found, creating it...`)
    fs.mkdirSync(functionsDir)
    this.log(`functions folder ${functionsDir} created`)
  }
  return functionsDir
}

// Download files from a given github URL
async function downloadFromURL(flags, args, functionsDir) {
  const folderContents = await readRepoURL(flags.url)
  const functionName = flags.url.split('/').slice(-1)[0]
  const nameToUse = await getNameFromArgs(args, flags, functionName)
  const fnFolder = path.join(functionsDir, nameToUse)
  if (fs.existsSync(fnFolder + '.js') && fs.lstatSync(fnFolder + '.js').isFile()) {
    this.log(`A single file version of the function ${name} already exists at ${fnFolder}.js`)
    process.exit(1)
  }

  try {
    fs.mkdirSync(fnFolder, { recursive: true })
  } catch (e) {
    // Ignore
  }
  await Promise.all(
    folderContents.map(({ name, download_url }) => {
      return fetch(download_url)
        .then(res => {
          const finalName = path.basename(name, '.js') === functionName ? nameToUse + '.js' : name
          const dest = fs.createWriteStream(path.join(fnFolder, finalName))
          res.body.pipe(dest)
        })
        .catch(err => {
          throw new Error('Error while retrieving ' + download_url)
        })
    })
  )

  this.log(`installing dependencies for ${nameToUse}...`)
  cp.exec('npm i', { cwd: path.join(functionsDir, nameToUse) }, () => {
    this.log(`installing dependencies for ${nameToUse} complete `)
  })

  // read, execute, and delete function template file if exists
  const fnTemplateFile = path.join(fnFolder, '.netlify-function-template.js')
  if (fs.existsSync(fnTemplateFile)) {
    const { onComplete, addons = [] } = require(fnTemplateFile)

    await installAddons.call(this, addons, path.resolve(fnFolder))
    if (onComplete) onComplete()
    fs.unlinkSync(fnTemplateFile) // delete
  }
}

// no --url flag specified, pick from a provided template
async function scaffoldFromTemplate(flags, args, functionsDir) {
  const chosentemplate = await pickTemplate() // pull the rest of the metadata from the template
  if (chosentemplate === 'url') {
    const { chosenurl } = await inquirer.prompt([
      {
        name: 'chosenurl',
        message: 'URL to clone: ',
        type: 'input',
        validate: val => !!validateRepoURL(val)
        // make sure it is not undefined and is a valid filename.
        // this has some nuance i have ignored, eg crossenv and i18n concerns
      }
    ])
    flags.url = chosenurl.trim()
    try {
      await downloadFromURL.call(this, flags, args, functionsDir)
    } catch (err) {
      console.error('Error downloading from URL: ' + flags.url)
      console.error(err)
      process.exit(1)
    }
  } else if (chosentemplate === 'report') {
    console.log('opening in browser: https://github.com/netlify/netlify-dev-plugin/issues/new')
    require('../../utils/openBrowser.js')('https://github.com/netlify/netlify-dev-plugin/issues/new')
  } else {
    const { onComplete, name: templateName, lang, addons = [] } = chosentemplate

    const pathToTemplate = path.join(templatesDir, lang, templateName)
    if (!fs.existsSync(pathToTemplate)) {
      throw new Error(
        `there isnt a corresponding folder to the selected name, ${templateName} template is misconfigured`
      )
    }

    const name = await getNameFromArgs(args, flags, templateName)
    this.log(`Creating function ${name}`)
    const functionPath = ensureFunctionPathIsOk.call(this, functionsDir, flags, name)

    // // SWYX: note to future devs - useful for debugging source to output issues
    // this.log('from ', pathToTemplate, ' to ', functionPath)
    const vars = { NETLIFY_STUFF_TO_REPLACE: 'REPLACEMENT' } // SWYX: TODO
    let hasPackageJSON = false
    copy(pathToTemplate, functionPath, vars, (err, createdFiles) => {
      if (err) throw err
      createdFiles.forEach(filePath => {
        this.log(`Created ${filePath}`)
        if (filePath.includes('package.json')) hasPackageJSON = true
      })
      // rename functions with different names from default
      if (name !== templateName) {
        fs.renameSync(path.join(functionPath, templateName + '.js'), path.join(functionPath, name + '.js'))
      }
      // delete function template file
      fs.unlinkSync(path.join(functionPath, '.netlify-function-template.js'))
      // npm install
      if (hasPackageJSON) {
        this.log(`installing dependencies for ${name}...`)
        cp.exec('npm i', { cwd: path.join(functionPath) }, () => {
          this.log(`installing dependencies for ${name} complete `)
        })
      }
      installAddons.call(this, addons, path.resolve(functionPath))
      if (onComplete) onComplete() // do whatever the template wants to do after it is scaffolded
    })
  }
}

async function installAddons(addons = [], fnPath) {
  if (addons.length) {
    const { api, site } = this.netlify
    const siteId = site.id
    if (!siteId) {
      this.log('No site id found, please run inside a site folder or `netlify link`')
      return false
    }
    return api.getSite({ siteId }).then(async siteData => {
      const accessToken = await this.authenticate()
      const arr = addons.map(({ addonName, addonDidInstall }) => {
        this.log('installing addon: ' + addonName)
        // will prompt for configs if not supplied - we do not yet allow for addon configs supplied by `netlify functions:create` command and may never do so
        return createSiteAddon(accessToken, addonName, siteId, siteData, this.log).then(async addonCreateMsg => {
          if (addonCreateMsg && addonDidInstall) {
            const { addEnvVarsFromAddons } = require('../../utils/dev-exec')
            await addEnvVarsFromAddons(site, accessToken)
            addonDidInstall(fnPath)
          }
        })
      })
      return Promise.all(arr)
    })
  }
}

// we used to allow for a --dir command,
// but have retired that to force every scaffolded function to be a folder
function ensureFunctionPathIsOk(functionsDir, flags, name) {
  const functionPath = path.join(functionsDir, name)
  if (fs.existsSync(functionPath)) {
    this.log(`Function ${functionPath} already exists, cancelling...`)
    process.exit(1)
  }
  return functionPath
}
