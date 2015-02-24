var fs = require('fs');
var path = require('path');
var _ = require('underscore');
var googleapis = require('googleapis');
var directory = googleapis.admin('directory_v1');
var gmail = googleapis.gmail('v1');
var walk = require('fs-walk');
var Q = require('q');
var levelup = require('levelup')

console.log(process.argv);
var spool_dir = process.argv[2];

//You find these under "Security", API Reference https://console.developers.google.com
var service_account_email = process.argv[3];
var subject_email = process.argv[4];


if (! subject_email) {
	console.log("Usage: node gmail-import.js [spool dir] [service account email] [email to migrate too]");
	process.exit();
}

//How many simultanous requests to do
const CONCURRENCY  = 20;
const MAX_WAIT  = 30; //Maximum number of seconds to wait in exponential backoff

// Google api scopes we'll need access to:
const SCOPES = [
  'https://mail.google.com/'
];

//Dirs to ignore: tweak for your setup
const IGNORE_DIRS = ['servers', 'templates', 'users', 'Trash', 'Junk', 'Drafts'];
const IGNORE_FILES = ['cyrus.index', 'cyrus.cache', 'cyrus.header', 'cyrus.squat']


//Folder names to map to specific labels in gmail
const LABEL_MAPPINGS = {
	'Sent' : 'INBOX',//gmail doesn't seem to like you inserting directly in sent items
	'.' : 'INBOX'
}



var seen_db = levelup(path.join(process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE, '.gmail-raw-mail-import', subject_email));


//Runs google api calls, resolves a promise when they're all done, and does "Exponential backoff" like google likes
// actions is an array of Promise-wrapped function (ie Q.nfcall).  Returns a promise for all the actions to be done.
function parallelCall(actions)  {
	//Actions can be an array or an iterator function (to allow parallel asynchronous generation of the list
	var iter =  actions;
	if (typeof(actions) != 'function') {
		iter = function() {
			if (actions.length) {
				return { 
					value: actions.shift(),
					done: false
				}
			}
			else {
				return { 
					value: null,
					done: true
				}
			}
		}
	}
	console.log(typeof(actions));

	console.log("Running parallel actions");
	var deferred = Q.defer();
	var active = 0;
	var results = [];

	//Function to process next action in the queue:
	var next = function(result) {

		if (result) {
			active --;
			results.push(result[0]);
			deferred.notify(result[0]);
		}
		var retry_count = 0;

		var next_action = iter();
		if (next_action.done) { 
			console.log("No more actions to run, waiting on " + active + " actions to complete");
			if (!active ) {
				console.log("Completed all actions"); //DONE
				deferred.resolve(results);
			}
			return;
		}
		//it's not done yet, but there's nothing to do, we need to wait for the list to be populated:
		if (!next_action.value) {
//			console.log("Starved the list of actions, waiting for more");
			return setTimeout( function() {
				next();
			}, 10 );
		}

		if (active >= CONCURRENCY) return;
		active ++;

		//A closure, to handle retrying this action:
		var retry = function(err, response) {
			//Is the error a 403 response?
			console.log("Error in action", err);
			if (err.code == 403) {
				retry_count ++;
				var wait_seconds = 2 ^ retry_count;
				if (wait_seconds > MAX_WAIT) {
					console.log("Asked to wait more than MAX_WAIT seconds, so dieing");
					process.exit();
				}
				console.log("Got 403 rate limiting response from google.  Waiting " + wait_seconds);
				setTimeout( function() {
					//Call the action again:
					action().then(next).fail(retry);
				}, wait_seconds * 1000 + rand() * 1000 );
			}
			else {				
				throw err;
				process.exit();
			}
		}

		var action = next_action.value;
		action().then(next).fail(retry);
	}
	for (i = 0 ;  i< CONCURRENCY;  i++ ) {
		console.log("Firing off another action");
		next();
	}
	return deferred.promise;
}

//Create all the folders in the mailbox as gmail labels
function createLabels(dir, subject_email, callback) {
	console.log('1. - Create labels in gmail for all folders for ' + subject_email);
	var labels = {};
	//Insert the label mappings:
	for (folder in LABEL_MAPPINGS) {
		labels[folder] = LABEL_MAPPINGS[folder]
	}

	var mailbox_folders = ['.'];

	walk.dirsSync(spool_dir, function(basedir, filename, stat, next) {
		for (i in IGNORE_DIRS) {
			if (basedir.match('.*/' + IGNORE_DIRS[i] + '/.*') || filename.match(IGNORE_DIRS[i])) return;
		}

		mailbox_folders.push(path.relative(spool_dir, path.join(basedir, filename)));
	}, function(err) {
		if (err) console.log(err);
	});

	gmail.users.labels.list(
		{	
			userId: subject_email
		}, 
		function(err, response) {
			if (err) {
				console.log('ERROR', err);
				process.exit();
			}	
			for (i in response.labels) {
				labels[response.labels[i].name] = response.labels[i].id;
			}

			//Find folders that don't have a label yet;
			var create_labels = [];
			for (i in mailbox_folders) {
				var name = LABEL_MAPPINGS[mailbox_folders[i]] || mailbox_folders[i];
				if (! labels[name]) {
					console.log("No gmail label found for ", mailbox_folders[i]);
					create_labels.push(name);
				}
			}
			var create = [];
			var actions = [];
			for (i in create_labels) {
				var name = create_labels[i];

				//Create an array of Promise-returning functions to run in parallel:
				actions.push(Q.nfbind(
					gmail.users.labels.create.bind(gmail.users.labels),
					{
						userId: 'me',
						resource: {
							name: name,
							labelListVisibility: 'labelShow',
							messageListVisibility: 'show'
						}

					})
							)	
			}
			
			parallelCall(
				actions
			)
				.progress( function(result) {
					//Created label
					console.log(result);
				})
				.then(function(results) {
					for (i in results) {
						var response = results[i]
						labels[response.name] = response.id;
					}
					console.log("Got final list of labels : ", labels);
					//Now start migrating messages:
					callback(labels);
				} )
				.catch(function(err) {
					console.log("ERROR creating labels");
					console.error(err)
					throw err;
				});
		})
}


//Import the actual messages from the spool
function importSpoolFiles(dir, subject_email, labels) {
	var files = [];
	var files_done = Q.defer();

	//This walks the spool adding all the files to a queue for the google api requests to consume.
	// Note we're doing this in parallel with the process of transmitting the files to google, because in a large spool this can take a while.
	walk.files(dir, function(basedir, filename, stat, next) {
		for (i in IGNORE_DIRS) {
			if (basedir.match('(.*/|^)' + IGNORE_DIRS[i] + '(/.*|$)') || filename.match(IGNORE_DIRS[i])) return next();
		}
		for (i in IGNORE_FILES) {
			if (filename.match(IGNORE_FILES[i])) return next();
		}
		var file = path.join(basedir, filename);
		seen_db.get(file, function(err, value) {

			if (! value ){
				files.push(file);
			}
			else {
				console.log("Seen  " + file, err, value);
			}
		})

		next();
	}, function(err) {
		if (err) console.error(err);
		files_done.resolve();
	});

	//A function to generate the next file (it'd like to be an Ecmascript 6 generator: newfangled! but too newfangled, don't want to depend on bleeding edge nodejs)
	var next_file = function() {
		if (! files_done.resolved) {
			var file = files.shift();
			if (file) {
				//Determine the correct labels:
				var relative = path.relative(dir, file);
				var folder = path.dirname(relative);
				var label = labels[folder];
				console.log("Uploading file " + file + "Folder: " + folder + " -> Label: " + label);
//				console.log(relative, folder, label);
				if (! label) {
					throw new Error("No label found");
				}
				//			var file = path.join(spool_dir, files[i]);

				return { 
					//A function to actually do the api call.  Q.nfbind wraps it in a promise-returning function:
					value : Q.nfbind(
							function(callback) { 
								gmail.users.messages.insert({
									userId: subject_email,
									internalDateSource: 'dateHeader',
									resource : {
										'labelIds': [label],
									},
									media: {
										mimeType: 'message/rfc822',
										body: fs.createReadStream(file)
									}, 
								},
								function(err, result) {
									if (err) console.error(err);
									if (! err) {
										seen_db.put(file, true, function(err) {
											if (err) return console.log('Error updating database', err) // some kind of I/O error
										})
									}
									callback(err, result)
								});
							}							
					),
					done : false 
				}
			}
			else {
				return {
					value :  null,
					done : false
				}
			}			
		}
		else {
			return { 
				value : null,
				done : true
			};
		}
	};

	//Fire off the google api requests
	var migrated_count = 0;
	var start_time = Date.now();
	parallelCall(next_file)
		.progress( function(result) {
			console.log(result);
			migrated_count ++;
			var current_time = Date.now();
			var elapsed = Math.round((current_time - start_time) / 1000);
			var messages_per_hour = Math.round((migrated_count/( elapsed || 1) )*3600, 1);
			var percent = Math.round(100* migrated_count / + (files.length + migrated_count), 1);
			var eta  = Math.round(files.length / (messages_per_hour | 1),2)
			console.log(elapsed +"s Migrated " + migrated_count + "/" + (files.length + migrated_count) + " " + percent + "% " +  messages_per_hour + "p/h ETA: " + eta + 'h');
		} )
		.then( function(results) {
			console.log("Migrated dir " + dir , results);
		})
		.fail(function(err) {
			console.error('ERROR');
			process.exit();
		});	
}

//Migrate a user's mailbox
function migrateUser(dir, subject_email) { 
	//https://developers.google.com/admin-sdk/directory/v1/guides/delegation
	// Convert to a PEM  key as per ; https://github.com/google/google-api-nodejs-client
	// openssl pkcs12 -in key.p12 -nocerts -passin pass:notasecret -nodes -out key.pem
	var key_path = 		path.join(process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE, 'key.pem'); //The key from above, assumed to be in your home dir
	console.log("Auth with google using " + service_account_email + " and key " + key_path);
	var jwtClient = new googleapis.auth.JWT(
		service_account_email,
		key_path,
		null,
		SCOPES,
		subject_email
	);
	googleapis.options({ auth: jwtClient });
	jwtClient.authorize(function(err, tokens) {
		if (err) {
			console.log(err);
			return;
		}
		console.log('0 - Authed with google.');
		createLabels(dir, subject_email, function(labels) {
			importSpoolFiles(dir, subject_email, labels) 
		});

	});
};
migrateUser(spool_dir, subject_email);
