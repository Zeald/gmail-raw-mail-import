# gmail-raw-mail-import
A nodejs script to import raw mail spools into gmail as part of a migration to google apps.  

Motivated by how slow importing our mail from cyrus IMAP into gmail was with the google supplied migration tools, this one reads raw mail spools (ie it doesn't operate over IMAP) and tries to be as fast a physically possible. For us at least it's about 20 times faster than the google cloud-based migration tool in the admin console.

It's not intended as an "off the shelf" user tool, It's been hacked up in a couple of days for a one-off import by us.  We probably aren't too interested in adding features or fixing bugs, as we only ever used it once!  But it might serve as a basis for your own import tools.  It's licensed under an MIT license, so just fork it on github and do as you please.


How it works, what it does
--------------------------

At the moment, it's designed to work with a raw cyrus IMAP mail partition.  It doesn't sync seen status.  It would probably work with small modifications on a standard UNIX maildir (eg Courier IMAP) as well.

You'll need to create a google apis service account and delegate it as per
https://developers.google.com/admin-sdk/directory/v1/guides/delegation

Convert the key to PEM format as per ; https://github.com/google/google-api-nodejs-client:

	 openssl pkcs12 -in key.p12 -nocerts -passin pass:notasecret -nodes -out ~/key.pem

The script will create a leveldb database in ~/.gmail-raw-mail-import, which it uses to track which emails it's migrated.  This means the script is idempotent, and can be run as many times as you like without having to reimport everything (gmail's got the brains to stop it duplicating your email, however it might take days reimporting things you've already imported).

Nodejs is perfect for this type of IO-limited parallel app, as we can afford to do a lot of requests in parallel without needing to deal with threads etc.  It tries to run a number of requests in parallel (see the CONCURRENCY constant).  It gracefully handles when google tries to rate limit it.

Usage
-----


    node gmail-import.js  /srv/mail/mail/j/user/joeblogs xxxxxxxxxx@developer.gserviceaccount.com  joe.blogs.gmail.user@yourcompany.com


