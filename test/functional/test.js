var  _ = require('underscore')
  , app = require('../../lib/app')
  , models = require('../../lib/models')
  , assert = require('assert')
  , common = require('../../lib/common')
  , config = require('../../test-config')
  , crypto = require('crypto')
  , exec = require('child_process').exec
  , EventEmitter = require('events').EventEmitter
  , fs = require('fs')
  , mongoose = require('mongoose')
  , path = require('path')
  , qs = require('querystring')
  , request = require('request')
  , should = require('should')
  , sinon = require('sinon')
  , Step = require('step')
  ;

var TEST_PORT=8700;

var TEST_BASE_URL="http://localhost:"+TEST_PORT+"/";

var TEST_WEBHOOK_SHA1_SECRET="l1ulAEJQyOTpvjz7r4yNtzZlL4vsV8Zy/jatdRUxvJc=";

TEST_USER_PASSWORD = "example";

var TEST_USERS = {
  "test1@example.com":{password: TEST_USER_PASSWORD, jar: request.jar()},
  "test2@example.com":{password: TEST_USER_PASSWORD, jar: request.jar()},
  "test3@example.com":{password: TEST_USER_PASSWORD, jar: request.jar()}
};

// parses a uri of the form mongodb://user:pass@host:post/dbname
function parseMongoURI(uri) {
  var db_name = uri.slice(uri.lastIndexOf('/') + 1);
  uri = uri.slice(uri.indexOf('://') + 3, uri.lastIndexOf('/'));
  var parts = uri.split('@');
  var db_host = parts[1];
  var authparts = parts[0].split(':');
  return {
    name: db_name,
    host: db_host,
    user: authparts[0],
    password: authparts[1]
  };
}

function toModel(collectionName) {
  var name = toTitleCase(collectionName);
  if (models[name]) {
    return models[name];
  } else if (models[name.slice(0, -1)]) {
    return models[name.slice(0, -1)];
  }
  throw Error('model for collection ' + collectionName + ' not found');
}

function toTitleCase(name) {
  return name[0].toUpperCase() + name.slice(1);
}

function fake_mongo_import(name, fname, cb) {
  var text = fs.readFileSync(fname).toString('utf8').replace(/\n/g, ',\n')
    , data = JSON.parse('[' + text.slice(0, -2) + ']')
    , model = toModel(name);
  model.remove({}, function (err) {
    if (err) return cb(err);
    model.create(data, cb);
  });
}

var has_mongo_import = true;
function importCollection(name, file, cb) {
  var filepath = path.join(__dirname, 'fixtures', file)
    , db_data = {
        name: path.basename(config.db_uri)
      };
  // Load the test data
  console.log("Loading test data ...");
  if (process.env.MONGODB_URI !== undefined) {
    db_data = parseMongoURI(process.env.MONGODB_URI);
  }
  if (process.env.MONGODB_USER !== undefined) {
    db_data.user = process.env.MONGODB_USER;
  }
  if (process.env.MONGODB_PASSWORD !== undefined) {
    db_data.password = process.env.MONGODB_PASSWORD;
  }
  var cmd = "mongoimport --drop -c " + name + " ";
  if (db_data.user && db_data.password) {
    cmd = cmd + " -u " + db_data.user + " -p " + db_data.password;
  }
  if (db_data.host !== undefined) {
    cmd += ' --host ' + db_data.host;
  }
  if (db_data.port !== undefined) {
    cmd = cmd + " --port " + db_data.port;
  }
  cmd = cmd + " -d " + db_data.name + " --file " + filepath;

  console.log("Loading data with command: %s", cmd);
  if (has_mongo_import) {
    exec(cmd, function (err, stdout, stderr) {
      if (err && err.code === 127) { // no mongoimport available
        has_mongo_import = false;
        return fake_mongo_import(name, filepath, cb);
      }
      cb.apply(null, arguments);
    });
  } else {
    fake_mongo_import(name, filepath, cb);
  }
}


describe('functional', function() {

  before(function(done) {
    this.timeout(10000);
    // Inject the test config
    common.workerMessageHooks = [];
    common.workerMessagePostProcessors = [];
    var server = app.init(config);
    var db_name = path.basename(config.db_uri);
    var db_port;
    // Load the test data
    Step(
      function() {
        importCollection("users", "users.json", this.parallel());
        importCollection("jobs", "jobs.json", this.parallel());
        importCollection("projects", "projects.json", this.parallel());
      },
      function(err, stdout, stderr) {
        if (err) {
          throw err;
        }
        console.log("Test data loaded.");
        server.listen(TEST_PORT);
        console.log("Server is listening on port %s", TEST_PORT);
        var self = this
        models.User.find({}, function (err, users) {
          for (var i=0; i<users.length; i++) {
            users[i].password = TEST_USER_PASSWORD;
            users[i].save(self.parallel())
          }
        })
      },
      done
    );
  });

  describe("auth", function() {
    it("should render /login page with a 200", function(done) {
        request.get(TEST_BASE_URL + "login", function (e, r, body) {
          r.statusCode.should.eql(200);
          done();
        });

    });

    it("bad login should return 302 with an error", function(done) {
        request.post({
            url:TEST_BASE_URL + "login",
            form:{email:"bad", password:"bad"}
          }, function (e, r, body) {
          r.statusCode.should.eql(302);
          r.headers.location.should.eql("/login#fail");
          done();
        });
    });

  });

  describe("api", function() {
    describe("#collaborators", function() {

      var clients = {};

      // log the various clients in
      before(function(done) {
        var complete = 0;
        _.each(TEST_USERS, function(opts, email) {
          clients[email] = request.post({url: TEST_BASE_URL + "login",
          form:{email:email, password:opts.password},
          jar:opts.jar,
          }, function(e, r, b) {
            if (e) {
              throw e;
            }
            if (r.statusCode !== 302 || r.headers.location !== '/') {
              console.log(opts);
              throw new Error("Test collaborator couldn't log in! Status code: " + r.statusCode + " email: " + email);
            }
            complete++;
            if (complete === _.size(TEST_USERS)) {
              console.log("collaborators: all users logged in, ready for tests :-)");
              done();
            }
          });
        });
      });

      it("should fetch a list of collaborators for an accessible repository", function(done) {
        var jar = TEST_USERS[Object.keys(TEST_USERS)[0]].jar
        request({
          url: TEST_BASE_URL + "jaredly/org-lite/collaborators/",
          jar: jar
        }, function(e, r, b) {
          r.statusCode.should.eql(200);
          var data = JSON.parse(b);
          // 1st test user should be the only collaborator at this point
          data[1].email.should.eql(Object.keys(TEST_USERS)[0]);
          data[1].access_level.should.eql(2);
          data[1].type.should.eql("user");
          done();
        });
      });

      it("should error if trying to fetch collaborators for an repository we don't have access to", function(done) {
        var jar = TEST_USERS[Object.keys(TEST_USERS)[1]].jar
        request({
          url: TEST_BASE_URL + "jaredly/org-lite/collaborators/",
          jar: jar
        }, function(e, r, b) {
          r.statusCode.should.eql(401);
          done();
        });
      });

      it("should be able to add an existing user as a collaborator and delete them", function(done) {
        var email_to_add = Object.keys(TEST_USERS)[1]
        var jar = TEST_USERS[Object.keys(TEST_USERS)[0]].jar
        console.log('adding', email_to_add)
        Step(
          // Add a new collaborator
          function() {
            request.post({
              url: TEST_BASE_URL + "jaredly/org-lite/collaborators/",
              qs: {email:email_to_add},
              jar: jar
            }, this);
          },
          // Verify success adding, start HTTP request to list collaborators
          function(e, r, b) {
            r.statusCode.should.eql(200);
            var data = JSON.parse(b)
            data.status.should.eql('success')
            request({
              url: TEST_BASE_URL + "jaredly/org-lite/collaborators/",
              jar: jar
            }, this);
          },
          // Verify that new user is now in collaborators list
          function(e, r, b) {
            if (e) throw e;
            r.statusCode.should.eql(200);
            var data = JSON.parse(b);
            // We should have two test users
            data.length.should.eql(3);
            data[1].email.should.eql(Object.keys(TEST_USERS)[0]);
            data[1].access_level.should.eql(2);
            data[1].type.should.eql("user");
            data[2].email.should.eql(Object.keys(TEST_USERS)[1]);
            data[2].access_level.should.eql(1);
            data[2].type.should.eql("user");
            // Now delete it
            request({
              url: TEST_BASE_URL + "jaredly/org-lite/collaborators/",
              qs: {email:email_to_add},
              method: "delete",
              jar: jar
            }, this);
          }, 
          function(e, r, b) {
            if (e) throw e;
            r.statusCode.should.eql(200);
            var data = JSON.parse(b);
            data.status.should.eql("removed");
            // Fetch collaborators list again
            request({
              url: TEST_BASE_URL + "jaredly/org-lite/collaborators/",
              jar: jar
            }, this);

          },
          function(e, r, b) {
            if (e) throw e;
            r.statusCode.should.eql(200);
            var data = JSON.parse(b);
            // We should have one test user
            data.length.should.eql(2);
            data[1].email.should.eql(Object.keys(TEST_USERS)[0]);
            data[1].access_level.should.eql(2);
            data[1].type.should.eql("user");
            done();
          }
        );
      });

      /* This doesn't test the right thing. This isn't modify
      it.only("should be able to modify an existing collaborator's access_level", function(done) {
        var email_to_add = Object.keys(TEST_USERS)[1]
        var jar = TEST_USERS[Object.keys(TEST_USERS)[0]].jar
        Step(
          // Give test2@example.com admin privileges
          function() {
            request.post({
              url: TEST_BASE_URL + "jaredly/org-lite/collaborators/",
              qs: {email:email_to_add, access_level:1},
              jar: jar
            }, this);
          },
          // Verify success, start HTTP request to list collaborators
          function(e, r, b) {
            r.statusCode.should.eql(200);
            var data = JSON.parse(b);
            data.status.should.eql("success");
            request({
              url: TEST_BASE_URL + "jaredly/org-lite/collaborators/",
              jar: jar
            }, this);
          },
          // Verify that new user is now in collaborators list with admin privileges
          function(e, r, b) {
            if (e) throw e;
            r.statusCode.should.eql(200);
            var data = JSON.parse(b);
            // We should have two test users
            data.length.should.eql(2);
            data[1].email.should.eql(Object.keys(TEST_USERS)[0]);
            data[1].access_level.should.eql(2);
            data[1].type.should.eql("user");
            data[2].email.should.eql(Object.keys(TEST_USERS)[1]);
            data[2].access_level.should.eql(2);
            data[2].type.should.eql("user");
            done();
          }
        );
      });
      */

      // not yet implemented
      it.skip("should not be able to add owner as a collaborator", function(done) {
        var owner_email = Object.keys(TEST_USERS)[0];
        var jar = TEST_USERS[Object.keys(TEST_USERS)[0]].jar;
        var new_jar = request.jar();
        var poang = "https://github.com/beyondfog/poang";
        Step(
          // Add a new collaborator
          function() {
            request.post({
              url: TEST_BASE_URL + "jaredly/org-lite/collaborators/",
              qs: {email:owner_email},
              jar: jar
            }, this);
          },
          // Verify success adding, query database for invite object with correct data
          function(e, r, b) {
            r.statusCode.should.eql(400);
            var data = JSON.parse(b);
            data.status.should.eql("error");
            data.errors[0].should.include("Can't add owner as collaborator");
            done();
          }
        );
      });

      it("should be able to invite a non-existing user as a collaborator", function(done) {
        var email_to_add = "testunregistered@example.com";
        var jar = TEST_USERS[Object.keys(TEST_USERS)[0]].jar;
        var new_jar = request.jar();
        var poang = "https://github.com/beyondfog/poang";
        Step(
          // Add a new collaborator
          function() {
            request.post({
              url: TEST_BASE_URL + "jaredly/org-lite/collaborators/",
              qs: {email:email_to_add},
              jar: jar
            }, this);
          },
          // Verify success adding, query database for invite object with correct data
          function(e, r, b) {
            r.statusCode.should.eql(200);
            var data = JSON.parse(b);
            data.status.should.eql("sent_invite");
            models.InviteCode.findOne({emailed_to: email_to_add, consumed_timestamp: null}, this);
          },
          // Verify the invite exists in database
          function(err, invite) {
            if (err) throw err;
            should.exist(invite);
            invite.collaborations[0].project.should.eql('jaredly/org-lite');
            invite.collaborations[0].access_level.should.eql(1);
            // try to register a new user using the invitation
            request.post({
              url: TEST_BASE_URL + "register",
              form: {invite_code: invite.code, email: email_to_add, password:"foopassword"},
              jar: new_jar
            }, this);
          },
          function(e, r, b) {
            if (e) throw e;
            r.statusCode.should.eql(302);
            r.headers.location.should.eql('/');
            // Verify the new user can see the repository it should be a collaborator for
            request.get({
              url: TEST_BASE_URL + "jaredly/org-lite/collaborators/",
              jar: new_jar
            }, this);
          }, function(e, r, b) {
            if (e) throw e;
            r.statusCode.should.eql(200);
            var data = JSON.parse(b);
            // We should have three test users
            data.length.should.eql(3);
            data[2].email.should.eql(email_to_add);
            data[2].access_level.should.eql(1);
            data[2].type.should.eql("user");
            data[1].email.should.eql(Object.keys(TEST_USERS)[0]);
            data[1].access_level.should.eql(2);
            data[1].type.should.eql("user");
            done();
          }

        );
      });
    })
  });


});
