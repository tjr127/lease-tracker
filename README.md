# Lease Tracker

A small phone app for tracking lease mileage. Log the odometer now and then; it tells you how far
under or over the lease line you are today, where you will finish at your current pace, and how
much you can drive per day, week, and month to stay inside the allowance.

No ads, no account, no build step. The app is a handful of static files served by GitHub Pages,
and the data lives in a Google Sheet you own.

## How it fits together

```
Phone (installed web app)  --->  GitHub Pages  (serves these files)
        |
        +--- readings --->  Apps Script web app  --->  your Google Sheet
```

- The phone keeps its own copy of the data, so the app opens and works with no signal.
  Changes made offline are saved to the Sheet the next time it can reach Google.
- The Sheet has two tabs, `Vehicles` and `Readings`. You can sort, chart, or fix rows by hand.
- The web app URL and passphrase are stored only on your phone. They are not in this repository.

## Set it up

### 1. Put the app on GitHub Pages

1. Push these files to a GitHub repository.
2. In the repository: Settings > Pages > Source: "Deploy from a branch", branch `main`, folder `/ (root)`.
3. After a minute the app is live at `https://<your-username>.github.io/<repository-name>/`.

### 2. Create the Sheet backend

1. Create a new Google Sheet (any name).
2. Extensions > Apps Script. Delete the sample code and paste in `google-sheet/Code.gs`.
3. On the first line, replace `change-me` with a passphrase of your own.
4. Deploy > New deployment > gear icon > Web app.
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Approve the permission prompt and copy the **Web app URL** (it ends in `/exec`).

"Anyone" means anyone who has the URL can reach the script, which is why it also checks the
passphrase. The URL itself is long and random; do not post it publicly.

### 3. Connect the phone

1. Open the GitHub Pages address in Chrome on your phone.
2. Menu (three dots) > Add to Home screen > Install.
3. In the app: Lease setup > Google Sheet. Paste the web app URL and your passphrase, then Connect Sheet.

Enter the lease details once (start date, length, total miles allowed, starting odometer, charge
per extra mile) and start logging.

## How the numbers are worked out

- **Lease line today** = total miles allowed x (days since lease start / total days in the lease).
- **Under / over** = lease line today minus miles driven (latest odometer minus starting odometer).
- **At your pace** = miles driven so far / days from lease start to your latest reading, carried
  forward to the end date.
- **You can drive** = miles left in the allowance / days left, shown per day, per week (x7), and
  per month (x 365.25 / 12).
- **Cost** = miles over x the charge per extra mile.

The lease end date is the start date plus the lease length in calendar months.

## Files

| File | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | The app: screens, storage, syncing |
| `lease-math.js` | All of the arithmetic, separate so it is easy to check |
| `sw.js`, `manifest.webmanifest`, `icons/` | Makes it installable and usable offline |
| `fonts/` | Overpass typeface (SIL Open Font License) |
| `google-sheet/Code.gs` | The script that goes in your Google Sheet |

## Changing the app later

Edit the files and push. Then bump `VERSION` at the top of `sw.js` (for example `lease-tracker-v2`)
so phones pick up the new files. If you change `Code.gs`, paste it into Apps Script again and use
Deploy > Manage deployments > edit > Version: New version, which keeps the same URL.
