var fs = require('fs');
var path = require('path');
var _ = require('underscore');
var googleapis = require('googleapis');
var directory = googleapis.admin('directory_v1');
var gmail = googleapis.gmail('v1');
var walk = require('fs-walk');
var Q = require('q');
var levelup = require('levelup')
var util = require('util');

var argv = require('yargs').argv;
//console.log(argv);

//console.log(process.argv);
var spool_dir = argv._[0];

//You find these under "Security", API Reference https://console.developers.google.com
var service_account_email = argv._[1];
var key_path =  argv._[2];
var subject_email = argv._[3];
var optional_subfolder = argv._[4];


var options = {
    flatten: argv.flatten,
    include_trash: argv['include-trash'],
    include_drafts: argv['include-drafts']
};

if (! subject_email) {
	console.log("Usage: node gmail-import.js [spool dir] [service account email] [key path] [email to migrate too] [optional label to put all the mail under]");
	process.exit();
}

//How many simultanous requests to do
const CONCURRENCY  = 20;
const MAX_WAIT  = 30*60; //Maximum number of seconds to wait in exponential backoff

// Google api scopes we'll need access to:
const SCOPES = [
  'https://mail.google.com/'
];

//Dirs to ignore: tweak for your setup
var IGNORE_DIRS = ['servers', 'templates', 'users'];
if (! options.include_drafts ) {
    IGNORE_DIRS.push('Drafts');
}
if (! options.include_trash ) {
    IGNORE_DIRS.push('Trash');
}


const IGNORE_FILES = ['cyrus.index', 'cyrus.cache', 'cyrus.header', 'cyrus.squat']


//Folder names to map to specific labels in gmail
// Note gmail labels seem to be case insensitive.  List the lower case label on the left
const LABEL_MAPPINGS = {
//	'sent' : 'inbox',//gmail doesn't seem to like you inserting directly in sent items
    'sent' : 'inbox',//gmail doesn't seem to like you inserting directly in sent items
    '.' : 'inbox',
    'important' : 'Important Email',
    'archive': 'Archives', //Another reserved label name
    'visas' : 'Visa Emails' //What the hell is the problem with this?
}

//https://developers.google.com/admin-sdk/directory/v1/guides/delegation
// Convert to a PEM  key as per ; https://github.com/google/google-api-nodejs-client
// openssl pkcs12 -in key.p12 -nocerts -passin pass:notasecret -nodes -out key.pem



//var key_path = path.join(process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE, 'key.pem');

var jwtClient = new googleapis.auth.JWT(
	service_account_email,
	key_path,
	null,
	SCOPES,
	subject_email
);
var authorising = false;
if (optional_subfolder) {
    var seen_db_path = path.join(process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE, '.gmail-raw-mail-import', subject_email, optional_subfolder);
} 
else {
    var seen_db_path = path.join(process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE, '.gmail-raw-mail-import', subject_email);
}
//fs.mkdirSync(seen_db_path);
var seen_db = levelup(seen_db_path);
var retry_count = 0;

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
//	console.log(typeof(actions));

//	console.log("Running parallel actions");
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

		var next_action = iter();
		if (next_action.done) { 
//			console.log("No more actions to run, waiting on " + active + " actions to complete");
			if (!active ) {
//				console.log("Completed all actions"); //DONE
				deferred.resolve(results);
			}
			return;
		}
		//it's not done yet, but there's nothing to do, we need to wait for the list to be populated:
		if (!next_action.value) {
//			console.log("Starved the list of actions, waiting for more");
			return setTimeout( function() {
			    active --;
			    next();
			}, 10 );
		}

		if (active >= CONCURRENCY) return;
		active ++;
		retry_count = 0;
		//Handle retrying this action with exponential backoff
		var retry = function(err, response) {
			//Is the error a 403 response?
		    console.log("Error in action", require('util').inspect(err), action);
			var exponential_backoff = function() {
				retry_count ++;
			    var wait_seconds = Math.pow(2, retry_count);
				if (wait_seconds > MAX_WAIT) {
					console.log("Asked to wait more than MAX_WAIT seconds, so dieing");
				}
				console.log("Rate limiting response from google.  Waiting " + wait_seconds);
				setTimeout( function() {
					//Call the action again:
					action().then(next).catch(retry).done();
				}, wait_seconds * 1000 + Math.random() * 1000 );

			}
			if (err.code == 401) { //We need to reauth?
				if (! authorising) {
					authorising = true;
					jwtClient.authorize(function(err, tokens) {
						authorising = false;
						if (err) {
							
							console.log(err);
							return;
						}
						console.log('0 - Re-authed with google.');
					});
				}

				exponential_backoff();
			}
			else if (err.code == 403) {  //A google rate-limiting response
				exponential_backoff();
			}
			else if (err.code == 400  ) { //Somethings broken about our request ; die to let the operator know.
				throw err;
				process.exit();

			}
			else {	//Who knows what's happened, let's try again in a bit:
				exponential_backoff();				
			}
		}

		var action = next_action.value;
		action().then(next).catch(retry).done();
	}
	for (i = 0 ;  i< CONCURRENCY;  i++ ) {
//		console.log("Firing off another action");
		next();
	}
	return deferred.promise;
}

//Convert paths to valid gmail labels.  Most of the rules for what is a valid gmail label seem to be undefined?
// these were discovered by trial and error.
function folderToLabelName(folder) {
    var name =   LABEL_MAPPINGS[folder.toLowerCase() ] || folder;
    //Leading and trailing whitespace must will result in "invalid label"
    name = name.replace(/^\s+/,'');
    name = name.replace(/\s+$/,'');

    //So will more than one space:
    name = name.replace(/\s+/g, ' ');

    return name;
}
function pathToLabelName(folder) {
    var label  =  _.map(folder.split(path.sep), folderToLabelName).join(path.sep);

//    console.log('L:',label);
    if (options.flatten) {
	if (label.toLowerCase() == 'drafts' || label.toLowerCase() == 'trash' ) {
	    //If we aren't ignoring drafts or trash, need them in.
	    console.log('Drafts');
	}
	else if (optional_subfolder ) {
	    return optional_subfolder ;
	}
	else {
	    label  =  'inbox';
	}

    }

    if (optional_subfolder) label = optional_subfolder + '/' + label;
    return label;

}

//Create all the folders in the mailbox as gmail labels
function createLabels(dir, subject_email, callback) {
	console.log('1. - Create labels in gmail for all folders for ' + subject_email);
	var labels = {};

	var mailbox_folders = ['.'];

	walk.dirsSync(spool_dir, function(basedir, filename, stat, next) {
	    var folder = path.relative(spool_dir, path.join(basedir, filename));
		for (i in IGNORE_DIRS) {
		    if (folder.match('^' + IGNORE_DIRS[i] + '(/.*)*$') ) {
			console.log("Ignoring  " , folder);
			return;
		    }
		}

		mailbox_folders.push(folder);
	}, function(err) {
		if (err) console.log(err);
	});

	gmail.users.labels.list(
		{	
			userId: subject_email
		}, 
		function(err, response) {
		    console.log(response);
		    if (err) {
			console.log('ERROR finding labels', err);
			process.exit();
		    }	
		    for (i in response.labels) {
			labels[response.labels[i].name.toLowerCase() ] = response.labels[i].id;
		    }


		    if (optional_subfolder) {
			mailbox_folders.push(optional_subfolder);
		    }

		    var current_labels = _.pluck( response.labels, 'name');
/*		    for (i in  current_labels.sort()) {
			console.log(current_labels[i]);			
		    }
*/	    

		    //Find folders that don't have a label yet;
		    var create_labels = [];
		    for (i in mailbox_folders) {
			var folder = mailbox_folders[i];
			
			//Map the path name
			var name = pathToLabelName(folder);
			if (! labels[name.toLowerCase()]) {
			    console.log("No gmail label found for folder: '" + mailbox_folders[i] + "' ; Gmail Label:'" + name + "'"); //'
			    create_labels.push(name);
			}
		    }
		    
		    create_labels = _.uniq(create_labels);
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
					//console.log(result);
				})
				.then(function(results) {
					for (i in results) {
						var response = results[i]
					    labels[response.name.toLowerCase()] = response.id;
					}
//				    console.log("Got final list of labels : ", labels);

				    //Now start migrating messages:
				    callback(labels);
				} )
				.catch(function(err) {
					console.log("ERROR creating labels");
					console.error(err)
					throw err;
				})
			    .done();
		})
}


//Import the actual messages from the spool
function importSpoolFiles(dir, subject_email, labels) {
	var files = [];
	var files_done = Q.defer();

	//This walks the spool adding all the files to a queue for the google api requests to consume.
	// Note we're doing this in parallel with the process of transmitting the files to google, because in a large spool this can take a while.
	walk.files(dir, function(basedir, filename, stat, next) {
//	    if (!basedir.match(/.*Sent$/i)) return next();


		for (i in IGNORE_DIRS) {
			if (basedir.match('(.*/|^)' + IGNORE_DIRS[i] + '(/.*|$)') || filename.match(IGNORE_DIRS[i])) return next();
		}
		for (i in IGNORE_FILES) {
			if (filename.match(IGNORE_FILES[i])) return next();
		}
	    var file = path.join(basedir, filename);
	    if (stat.size > 32 * 1024 * 1024) {
		console.log("FILE is > 32Mb and cannot be uploaded", file);
		return next();
	    }

		seen_db.get(file, function(err, value) {

			if (! value ){
				files.push(file);
			}
			else {
			    //console.log("Seen  " + file, err, value);
			}
		})

		next();
	}, function(err) {
		if (err) console.error(err);
		files_done.resolve();
	});

	//A function to generate the next file (it'd like to be an Ecmascript 6 generator: newfangled! but too newfangled, don't want to depend on bleeding edge nodejs)
	var next_file = function() {
		var file = files.shift();
		if (file) {
			//Determine the correct labels:
			var relative = path.relative(dir, file);
			var folder = path.dirname(relative);
			
			//Map the path name
		    var name =  pathToLabelName(folder)
		    var label = labels[name.toLowerCase()];
		    
		    console.log(relative, folder, label);

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
			//No files in the list, perhaps we are waiting for the file scanning to add them?
			if (! files_done.promise.isFulfilled()) {
				return {
					value :  null,
					done : false
				}
			}			
			else {
				return { 
					value : null,
					done : true
				};
			}

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
		.fail(function(err) {
		    console.error('ERROR', err);
			process.exit();
		})
		.done( function(results) {
			console.log("Migrated dir " + dir , results);
		})
	;	
}

//Migrate a user's mailbox
function migrateUser(dir, subject_email) { 
	console.log("Auth with google using " + service_account_email + " and key " + key_path);
	googleapis.options({ auth: jwtClient });
	jwtClient.authorize(function(err, tokens) {
		if (err) {
		    console.log(err);
		    throw(err);
		    return;
		}
		console.log('0 - Authed with google.');
		createLabels(dir, subject_email, function(labels) {
			importSpoolFiles(dir, subject_email, labels) 
		});

	});
};
migrateUser(spool_dir, subject_email);
