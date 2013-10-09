var app = require('./lib/app')
  , common = require('./lib/common')
  , config = require('./lib/config')
  , Loader = require('strider-extension-loader')
  , middleware = require('./lib/middleware')
  , auth = require('./lib/auth')
  , models = require('./lib/models')
  , pluginTemplates = require('./lib/pluginTemplates')
  , utils = require('./lib/utils')

  , Job = models.Job

  , upgrade = require('./lib/models/upgrade').ensure

  , path = require('path')
  , async = require('async')
  , _ = require('lodash')

// require('express-namespace')

common.extensions = {}
// require('./defaultExtensions')(common.extensions);

//
// ### Register panel
//
// A panel is simply a snippet of HTML associated with a given key.
// Strider will output panels registered for specific template.
//
function registerPanel(key, value) {
  // Nothing yet registered for this panel
  key = value.id // 
  console.log("!! registerPanel", key)
  if (common.extensions[key] === undefined) {
    common.extensions[key] = {panel : value}
  } else {
    if (common.extensions[key].panel){
      console.log("!!", key, common.extensions[key], value)
      throw "Multiple Panels for " + key
    }
    common.extensions[key].panel = value;
  }
}

module.exports = function(extdir, c, callback) {
  var appConfig = config;
  // override with c
  for (var k in c){
    appConfig[k] = c[k];
  }

  // Initialize the (web) app
  var appInstance = app.init(appConfig);
  var cb = callback || function(err) {
    if (err) throw err;
  }

  var loader = appInstance.loader = new Loader()
  common.loader = loader
  //
  // ### Strider Context Object
  //
  // Context object is passed to each extension.  It carries various config
  // settings, as well as handles to enable functions to register things.
  // Context can also be accessed as a singleton within Strider as
  // common.context.
  var context = {
    config: appConfig,
    enablePty: config.enablePty,
    emitter: common.emitter,
    extensionRoutes: [],
    extensionPaths: extdir,
    extdir: extdir,
    loader: loader,
    models: models,
    logger: console,
    middleware: middleware,
    auth: auth, //TODO - may want to make this a subset of the auth module
    registerPanel: registerPanel,
    registerBlock: pluginTemplates.registerBlock,
    app: appInstance
  };

  // Make extension context available throughout application.
  common.context = context;

  var SCHEMA_VERSION = 1
  upgrade(SCHEMA_VERSION, function (err) {
    if (err) return cb(err)
    loadExtensions(loader, extdir, context, appInstance, function (err) {
      killZombies(function () {
        var tasks = []
        if (!common.extensions.runner || 'object' !== typeof common.extensions.runner) {
          console.error('Strider seems to have been misconfigured - there are no available runner plugins. Please make sure all dependencies are up to date.')
          process.exit(1)
        }
        Object.keys(common.extensions.runner).forEach(function (name) {
          var runner = common.extensions.runner[name]
          if (!runner) {
            console.log('no runner', name)
            return
          }
          tasks.push(function (next) {
            Job.find({'runner.id': name, finished: null}, function (err, jobs) {
              if (err) return next(err)
              runner.findZombies(jobs, next)
            })
          })
        })
        async.parallel(tasks, function (err, zombies) {
          if (err) return cb(err)
          var ids = [].concat.apply([], zombies).map(function (job) { return job._id })
            , now = new Date()
          Job.update({_id: {$in: ids}}, {$set: {finished: now, errored: true, error: {message: 'Job timeout', stack: ''}}}, function (err) {
            Job.update({_id: {$in: ids}, started: null}, {$set: {started:  now}}, function (err) {
              cb(err, appInstance)
            })
          })
        })
      })
    })
  })

  return appInstance
}

function killZombies(done) {
  var twoHoursAgo = new Date(new Date().getTime() - 2 * 60 * 60 * 1000)
  Job.update({finished: null, created: {$lt: twoHoursAgo}}, {$set: {finished: new Date(), errored: true}}, {multi: true}, done)
}

function loadExtensions(loader, extdir, context, appInstance, cb) {
  loader.collectExtensions(extdir, function (err) {
    if (err) return cb(err)
    async.parallel([
      function (next) {
        loader.initWebAppExtensions(context, function (err, webapps) {
          if (err) return next(err)
          common.extensions = webapps
          var id
          console.log('Job Plugins:')
          for (id in webapps.job) {
            console.log('- ' + id)
          }
          console.log('Provider Plugins:')
          for (id in webapps.provider) {
            console.log('- ' + id)
          }
          console.log('Runner Plugins:')
          for (id in webapps.runner) {
            console.log('- ' + id)
          }
          console.log('Basic Plugins:')
          for (id in webapps.basic) {
            console.log('- ' + id)
          }
          console.log('initalized webapps')
          next()
        })
      },
      function (next) {
        loader.initTemplates(function (err, templates) {
          if (err) return next(err)
          for (var name in templates) {
            pluginTemplates.register(name, templates[name])
          }
          console.log('loaded templates')
          next()
        })
      },
      function (next) {
        loader.initStaticDirs(appInstance, function(err) {
          console.log('initalized static directories')
          next()
        })
      },
      function (next) {
        loader.initConfig(
          path.join(__dirname, 'public/javascripts/pages/config-plugins-compiled.js'),
          path.join(__dirname, 'public/stylesheets/css/config-plugins-compiled.css'),
          function (err, configs) {
            console.log('loaded config pages')
            common.pluginConfigs = configs
            loader.initUserConfig(
              path.join(__dirname, 'public/javascripts/pages/account-plugins-compiled.js'),
              path.join(__dirname, 'public/stylesheets/css/account-plugins-compiled.css'),
              function (err, configs) {
                console.log('loaded account config pages')
                common.userConfigs = configs
                next()
              })
          })
      }
    ], function (err) {
      if (err) {
        console.error('Failed to load plugins')
        return cb(err, appInstance)
      }
      console.log('loaded plugins')
      app.run(appInstance)
      cb(null, appInstance)
    })
  })
}
