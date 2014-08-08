
var Promise = require('es6-promise').Promise;
var spawn = require('child_process').spawn;
var fs = require('fs');
var net = require('net');
var util = require('util');
var EventEmiter = require('events').EventEmitter;
var mongo = require('./mongo');
var tools = require('./tools');
var mongoServer = null;
var config = tools.getConfig();
var path = require('path');
var buildAsPromise = require('./build');

module.exports = Gagarin;

function Gagarin (options) {
  options = options || {};
  
  var port = 4000 + Math.floor(Math.random() * 1000);
  var dbName = options.dbName || 'gagarin_' + Date.now();
  var env = Object.create(process.env);
  var meteorConfig = tools.getReleaseConfig(options.pathToApp);

  env.ROOT_URL = 'http://localhost:' + port;
  env.PORT = port;
  
  if (!mongoServer) {
    // only do it once
    if (!config.mongoPath) {
      config.mongoPath = path.join(tools.getUserHome(), '.meteor', 'tools', meteorConfig.tools, 'mongodb', 'bin', 'mongod');
    }
    mongoServer = new mongo.Server(config);
  }

  var configure = mongoServer.then(function (mongoHandle) {
    env.MONGO_URL = 'mongodb://localhost:' + mongoHandle.port + '/' + dbName;
    return buildAsPromise(options.pathToApp);
  });

  var gagarinAsPromise = new GagarinAsPromise(configure.then(function (pathToMain) {

    return new Promise(function (resolve, reject) {
      // add timeout ??

      // TODO: guess the correct path from .meteor/release file
      var nodePath = path.join(tools.getUserHome(), '.meteor', 'tools',  meteorConfig.tools, 'bin', 'node');
      var meteor = spawn(nodePath, [ pathToMain ], { env: env });
      var gagarin = null;
      
      meteor.stdout.on('data', function (data) {
        var match;
        if (!gagarin) {
          match = /Gagarin listening at port (\d+)/.exec(data.toString());
          if (match) {
            gagarin = new GagarinTransponder(meteor, { port: parseInt(match[1]), cleanUp: function () {
              return mongo.connect(mongoServer, dbName).then(function (db) {
                return db.drop();
              });
            }});
            resolve(gagarin);
          }
        }
      });

      // TODO: only log in verbose mode
      meteor.stderr.on('data', function (data) {
        console.error(data.toString());
      });

    });

  }));
  
  gagarinAsPromise.location = env.ROOT_URL;
  
  return gagarinAsPromise;
}

Gagarin.config = function (options) {
  Object.keys(options).forEach(function (key) {
    config[key] = options[key];
  });
};

// GAGARIN AS PROMISE

function GagarinAsPromise (operand, promise) {
  this._operand = operand;
  this._promise = promise || operand;
}

GagarinAsPromise.prototype.sleep = function (timeout) {
  var self = this;
  return self.then(function () {
    return new Promise(function (resolve) {
      setTimeout(resolve, timeout);
    });
  });
};

GagarinAsPromise.prototype.expectError = function (callback) {
  var self = this;
  return self.then(function () {
    throw new Error('exception was not thrown');
  }, callback);
};

// proxies for promise methods

[ 'then', 'catch' ].forEach(function (name) {
  GagarinAsPromise.prototype[name] = function () {
    return new GagarinAsPromise(this._operand, this._promise[name].apply(this._promise, arguments));
  }
});

// proxies for transponder methods

[ 'eval', 'promise', 'exit' ].forEach(function (name) {
  GagarinAsPromise.prototype[name] = function () {
    var args = Array.prototype.slice.call(arguments, 0);
    var self = this;
    return new GagarinAsPromise(self._operand, Promise.all([ self._operand, self._promise ]).then(function (all) {
      return all[0][name].apply(all[0], args);
    }));
  };
});

// GAGARIN API

function GagarinTransponder(meteor, options) {

  // iherit from EventEmitter
  EventEmiter.call(this);

  var self = this;
  var connect = new Promise(function (resolve, reject) {
    var socket = net.createConnection(options.port, function () {
      resolve(socket);
    });

    //--------------- PARSE RESPONSE FROM SERVER ------------------
    socket.setEncoding('utf8');
    socket.on('data', function (data) {
      try {
        data = JSON.parse(data);
        //----------------------
        if (data.error) {
          if (data.name) {
            self.emit(data.name, new Error(data.error));
          } else {
            self.emit('error', new Error(data.error));
          }
        } else {
          data.name && self.emit(data.name, null, data.result);
        }
      } catch (err) { // parse error?
        self.emit('error', err);
      }
    });
    //-------------------------------------------------------------
    //\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\
    //-------------------------------------------------------------
  });

  function factory(mode) {
    return function (code) {
      var args = Array.prototype.slice.call(arguments, 1);
      var name = uniqe().toString();
      //-------------------------------------
      return connect.then(function (socket) {
        socket.write(JSON.stringify({
          code: code.toString(),
          mode: mode,
          name: name,
          args: args,
        }), function () {
          // do we need this callback (?)
        });
        return new Promise(function (resolve, reject) {
          self.once(name, tools.either(reject).or(resolve));
        });
      });
    }
  }

  self.promise = factory('promise');
  self.eval    = factory('evaluate');

  self.restart = function () {
    return tools.exitAsPromise(meteor);
  };

  self.exit = function () {
    return Promise.all([
      options.cleanUp(),
      tools.exitAsPromise(meteor),
    ]);
  };// exit

};

util.inherits(GagarinTransponder, EventEmiter);

// HELPERS

function uniqe() {
  if (!uniqe.counter) { uniqe.counter = 0; }
  return uniqe.counter++;
}


