Windows sync-group upgrade

Stop the existing storage client and its automatic restarter. Run Check.cmd, then Update.cmd, supplying the existing NasBridge repository or storage-client directory. Restart using the existing service. Node.js 20+ is required; existing dependencies are reused. The updater preserves credentials, storage root and AI settings. Backups are in storage-client/.nasbridge-updates; Rollback.cmd restores an unchanged installation using the printed backup ID.

In the website, log in as admin, open Terminal management > Sync groups, select 2-8 upgraded endpoints and their relative directories, select an always-on coordinator, then associate. Changes and deletions propagate every 60 seconds; Run now triggers a cycle. Unlinking preserves files and revokes transfers; disconnected endpoints stop when the 30-second lease expires. First association or membership changes merge existing content instead of inferring past deletions.
