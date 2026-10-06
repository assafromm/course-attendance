# Course Attendance — נוכחות

Hebrew, RTL attendance application implementing the decisions from “שיפור מערכת נוכחות”. The complete earlier requirements were recovered through its associated cloud Work conversation on October 6, 2026.

## Run locally

Requires Node.js 24 or later.

```powershell
npm.cmd install
Copy-Item .env.example .env
npm.cmd run dev
```

Open http://localhost:4173 and select the clearly marked local development login. This login is only enabled when `DEV_LOGIN=true`, `NODE_ENV` is not production, and the server binds to localhost. It is never available in production. The included `sample-roster.csv` contains fictional students and text identifiers with leading zeros.

## Implemented

- Separate course/group records and lecturer membership.
- CSV and XLSX roster import, column mapping, previews, missing-data and duplicate checks; updates preserve existing attendance and student IDs.
- Meetings with unlimited registration by default, optional opening/closing windows and manual closure/reopening.
- Up to 300 active cryptographically random QR slips per meeting, A4 printing, and save-to-PDF through the browser print dialog. Unused slips can be revoked by printed number with a reason; revoked numbers are never reused, and replacement slips can be issued.
- Only token hashes are stored; raw slip links are available once at issuance. Save the printout before closing it.
- Explicit student confirmation, course roster search, partial identifiers to distinguish names, and remembered selection on the device.
- Repeat-scan display of the registered identifier and correction while registration remains open.
- Database transactions and unique constraints prevent duplicate student registrations. A rejected duplicate does not consume an unused slip.
- Manual lecturer registration with a mandatory reason, attendance CSV export, and append-only audit records.
- Verified Google login with any email domain, administrator-approved active lecturers and course-specific authorization. Private Gmail accounts and external Google Workspace accounts are supported; this is not open registration.
- Optional Supabase Google OAuth with PKCE, adapted from Journal Compass. The server verifies the access token with its Auth service and checks the verified Google identity. Browser-supplied roles and editable user metadata are not trusted.
- Administrator lecturer directory with disabling/re-enabling access. Disabling access immediately revokes existing attendance sessions. Course owners can separately remove team access without deleting history.
- A white, sky-blue and red visual theme adapted from Journal Compass.

The method relies on controlled physical distribution of one slip per attendee. It cannot guarantee prevention of impersonation or photograph sharing. A slip remains a bearer key to view and correct its registration while the meeting is open; keep it private.

## Verification

```powershell
npm.cmd test
npm.cmd run build
```

Thirteen tests cover token secrecy, permissions, duplicate attempts, correction, roster-update history, registration windows, audit immutability, identity verification, revocation, role/course-aware navigation and exact twenty-slip pagination. Lecturers cannot read the audit log through either API. The cloud SQL migrations are tested in embedded PostgreSQL with pgcrypto. Public Google login was verified. Phone scanning and print-to-PDF should be checked before a real class.

## Hosting agreed with the user

The public frontend uses GitHub Pages and a dedicated Supabase PostgreSQL backend. No paid Node server or Sites hosting is required. Free provider plans have quotas and availability limits; establish student-data retention, access review and backups before institutional use.

Repository: `assafromm/course-attendance`. Intended site: `https://assafromm.github.io/course-attendance/`.

1. Enable Google OAuth in the dedicated Supabase project. Add the exact public site URL and `http://localhost:4173/` to its allowed redirects; set the public site as the default Site URL.
2. Run the SQL files in `supabase/migrations/` in filename order, once each, in that isolated project. The first creates private RLS tables and a checked RPC; the external-lecturers migration removes the original university-domain requirement without changing existing authorizations or data. Do not run these over another application's database.
3. Enable GitHub Pages with GitHub Actions. `.github/workflows/pages.yml` tests and builds with `VITE_CLOUD=true` and the public Supabase URL/publishable key, then deploys the static frontend. No privileged service key belongs in this repository or browser.
4. Verify Google login, roster import, phone QR scan, teacher isolation, printing, closure and correction using the production URLs before a real class. Existing local courses and localhost slips do not automatically transfer or work on students' phones; issue slips from the public site.

Do not copy local rosters or the SQLite database into the repository. Local and cloud databases are independent. A local Node/SQLite deployment remains available through the included Dockerfile for separately managed hosts.

### Supabase Google login option

Set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and `ADMIN_EMAILS`. The interface then uses Supabase instead of the direct Google-ID-token flow. Google must be enabled with the exact `${FRONTEND_URL}/` callback URL. PKCE state uses sessionStorage and permissions remain in the attendance database. Domain restrictions are not used: only verified Google accounts explicitly authorized by the administrator or course owner may access attendance data.

The Journal Compass source confirmed that it uses Supabase Google OAuth with invitation-backed roles, and the attendance implementation adapts that approach. Its live settings and database were not modified or copied. Attendance uses an isolated project. Verified Google identities and active lecturer permissions are checked on every privileged cloud request; no university-domain restriction applies. Browser-supplied roles and editable user metadata are not trusted.

Teacher disabling preserves course memberships and owned course records. Re-enabling access restores those preserved memberships, but previously revoked session tokens remain invalid. System administrators cannot be disabled through the UI. Owners cannot remove their own ownership.

## Architecture

- `src/main.jsx`: lecturer and student interface, import wizard and print layout.
- `server/index.js`: authenticated HTTP API, origin checks, Google token verification and local development server.
- `server/store.js`: SQLite schema, transactional claim/correction logic, token hashing and append-only audit.
- `src/cloud.js`: cloud RPC transport and public build configuration.
- `supabase/migrations/20261006_attendance.sql`: private cloud schema, authorization, transactional RPC and append-only audit.
- `src/print.css`, `src/print-layout.js`: explicit A4 pages with four columns and five rows, 20 slips per page and 26mm QR codes. Print at 100% size, with browser headers/footers disabled. Long headings are constrained to their own text area and never overlap adjacent slips.
- `src/navigation.js`: course-aware navigation; activity logs are administrator-only. Administrators retain system-level lecturer access management even with no selected course.
- `data/`: local persistent database, ignored by Git and Docker.
- `dist/`: generated static frontend, ignored by Git.

The frontend retains the Google session in sessionStorage and uses HTTPS in production. Student tokens live in URL fragments, so GitHub Pages never receives them. Cloud tokens are sent in HTTPS RPC bodies, not request paths; never log raw RPC bodies. Direct table/helper access is denied to anonymous and authenticated clients. Persistent per-lecturer/per-hashed-slip limits are not a complete defense against distributed anonymous flooding. A local Node backend must disable raw request-path logging for `/api/slip/*`.

Official integration references: [Google server-side ID-token verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token), [GitHub Pages workflow](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
