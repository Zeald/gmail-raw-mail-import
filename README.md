# gmail-raw-mail-import
A nodejs script to import raw mail spools into gmail as part of a migration to google apps.  Motivated by how slow importing our mail from cyrus IMAP into gmail was with the google supplied migration tools, this one reads raw mail spools (ie it doesn't operate over IMAP) and tries to be as fast a physically possible. It's not intended as an "off the shelf" tool but might be useful to others as a basis for a similar script operating against your own internal mail systems.

At the moment, it's designed to work with a raw cyrus IMAP mail partition.  It doesn't sync seen status.   
