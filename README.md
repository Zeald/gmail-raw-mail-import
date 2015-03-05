# gmail-raw-mail-import
A nodejs script to import raw mail spools into gmail as part of a migration to google apps.  

Motivated by how slow importing our mail from cyrus IMAP into gmail was with the google supplied migration tools, this one reads raw mail spools (ie it doesn't operate over IMAP) and tries to be as fast a physically possible. For us (down in New Zealand, miles away from the googleplex) it's at least it's about 20 times faster than the google cloud-based migration tool in the admin console.

It's not intended as an "off the shelf" user tool, It's been hacked up in a couple of days for a one-off import by us.  We probably aren't too interested in adding features or fixing bugs, as we only ever used it once!  But it might serve as a basis for your own import tools.  It's licensed under an MIT license, so just fork it on github and do as you please.


How it works, what it does
--------------------------

At the moment, it's designed to work with a raw cyrus IMAP mail partition.  It doesn't sync seen status.  It would probably work with small modifications on a standard UNIX maildir (eg Courier IMAP) as well.  With a few more modifications, you could probably make it work against any arbitrarily odd mailsystem you might have inhouse.

You'll need to create a google api account with "service account" credentials, and delegate it to access all your apps users as per:
https://developers.google.com/admin-sdk/directory/v1/guides/delegation

Convert the key to PEM format as per ; https://github.com/google/google-api-nodejs-client:

	 openssl pkcs12 -in key.p12 -nocerts -passin pass:notasecret -nodes -out ~/key.pem

The script will create a leveldb database in ~/.gmail-raw-mail-import, which it uses to track which emails it's migrated.  This means the script is idempotent, and can be run as many times as you like without having to reimport everything.  Handy if you find a bug.

Nodejs is perfect for this type of IO-limited parallel app, as we can afford to do a lot of requests in parallel without needing to deal with threads etc.  It tries to run a number of requests in parallel (see the CONCURRENCY constant).  The script tries gracefully handle when google tries to rate limit it, or when a transient network issue happens. With enough parallelism, and on our internet connection, Google seems to max out doing this at about a message a second (each individual request takes about 10s though).

Each instance of the script migrates one mailbox, but you can migrate multiple mailboxes in parallel without them much slowing each other down (I ran the script in multiple 'screen' sessions rather than making the script do more than one mailbox at a time: easier to debug).  Probably, you should run as many as your disk/network/cpu can handle: I haven't really found a point of diminishing returns on parallel mailbox imports.

Usage
-----


    node gmail-import.js  /srv/mail/mail/j/user/joeblogs xxxxxxxxxx@developer.gserviceaccount.com  ~/key.pem joe.blogs.gmail.user@yourcompany.com


