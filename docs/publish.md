# Publishing the dashboard

`ufp-speed publish` builds a public copy of the dashboard into `public/` and, with `--deploy`,
uploads it to Cloudflare. It is read-only against `data/speeds.db`, so it is safe to run alongside
`daemon` and `backfill`.

```sh
npm run ufp-speed -- publish                       # build into ./public and stop
npm run ufp-speed -- publish --deploy              # build, then upload once
npm run ufp-speed -- publish --deploy --every 15m  # stay up and repeat
```

## What is different about the published copy

It is the same page and the same components. Two things are removed, and one is added:

- **No playback and no link to Protect.** The published site has no route to the controller, so
  offering either would be a button that cannot work. `PassesResponse.playback` is false and the
  table drops its last column.
- **No `protectUrl`.** That field is `https://<UFP_HOST>/protect/events/<id>` on every row - the
  address of the controller, repeated once per vehicle. It is stripped by `publicPass()` in
  `src/dashboard/publish.ts`, not in the database, so the local dashboard keeps its audit trail.
- **A timezone.** `Summary.timeZone` records the zone the snapshot was built in, so a reader
  somewhere else still sees when the traffic actually went past.

`test/publish.test.ts` reads every byte of a real export and fails if an IP address, a `protectUrl`,
a `/protect/events/` link or an `/api/clip` route appears in the published data.

## One-time Cloudflare setup

`wrangler.jsonc` names one particular deployment, so it is gitignored the way `config.json` is.
Start from the template:

```sh
cp wrangler.example.jsonc wrangler.jsonc
```

Then set `name` to the Worker name and `routes[0].pattern` to the hostname to serve from. That
hostname's domain must already be a zone on the Cloudflare account, or the Custom Domain cannot be
created - delete the `routes` block to deploy to a `*.workers.dev` subdomain instead.

```sh
npx wrangler login     # interactive - opens a browser
npx wrangler whoami    # confirms the account
npx wrangler deploy    # creates the Worker and its DNS record
```

The first deploy creates the DNS record and the certificate, which takes a minute or two to go live.
A brand-new hostname can also be held up by whatever resolver you are behind having cached the empty
answer from before it existed; that clears itself within the zone's negative-cache TTL.

There is no Worker code - `wrangler.jsonc` has an `assets` directory and no `main` - so Cloudflare
serves the files straight from its edge. `secrets.required` is set to the empty list so that
Wrangler does not read the controller credentials out of `.env`; `wrangler deploy --dry-run` should
always report `No bindings found`.

## Running it unattended

`--every 15m` is the simplest thing that works and is easy to watch, but it dies with the terminal.
To keep it running across reboots, install a LaunchAgent. Build first (`npm run build`), then write
`~/Library/LaunchAgents/com.example.speed-camera.publish.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.example.speed-camera.publish</string>
  <key>WorkingDirectory</key><string>/path/to/speed-camera</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/path/to/speed-camera/dist/cli.js</string>
    <string>publish</string>
    <string>--deploy</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <!-- Every 15 minutes. launchd skips runs while the machine is asleep and catches up on wake. -->
  <key>StartInterval</key><integer>900</integer>
  <key>StandardOutPath</key><string>/tmp/traffic-publish.log</string>
  <key>StandardErrorPath</key><string>/tmp/traffic-publish.log</string>
</dict>
</plist>
```

```sh
launchctl load ~/Library/LaunchAgents/com.example.speed-camera.publish.plist
launchctl start com.example.speed-camera.publish
tail -f /tmp/traffic-publish.log
```

Unattended runs should use a scoped API token rather than the browser login, because an OAuth
session can need re-authorising and a LaunchAgent has nobody to ask. Create one in the Cloudflare
dashboard with **Edit Cloudflare Workers** on this account, add it to `.env` as
`CLOUDFLARE_API_TOKEN=...`, and add it to the plist's `EnvironmentVariables`.

## Cost and limits

The site is static assets only. Asset requests are not billed as Worker invocations, and each
deploy uploads only the files whose contents changed - which after the first upload is the twenty
JSON snapshots, a few hundred kilobytes. Ninety-six deploys a day sits well inside the free tier.

## If the numbers on the public page look stale

The page reports freshness from `Summary.generatedAtMs` - when the snapshot was *built*, not when
the browser downloaded it - so "measured up to 40 min ago" means the publisher has not run, not that
the page failed to refresh. Check `/tmp/traffic-publish.log`, or that the Mac was awake.
