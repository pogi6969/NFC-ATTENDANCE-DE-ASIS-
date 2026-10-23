# De Asis NFC Attendance

Students tap their NFC ID card at the campus gate. The time they **enter** and **leave** is saved in the cloud database, and their parents get a **text message** and an **app notification** right away.

| Part | Address | Who uses it |
| --- | --- | --- |
| Website | `/` | Everyone: what the system does, links to the app and dashboard |
| School dashboard | `/admin/` | Admin and staff: students, cards, parents, live taps, reports, readers, messages, settings |
| App (installable) | `/app/` | **Parents**: children's status, history, notifications. **Gate reader**: turns a phone/tablet into the NFC reader |

## How it works

1. A student taps their card on a gate reader (Android phone/tablet, USB reader, ESP32 wall reader).
2. The reader sends the card ID to `POST /api/tap`. The server finds the student and records **IN** (first tap of the day) or **OUT** (next tap), with the time and gate, in the database. Repeat taps within 60 seconds are ignored.
3. Every parent number on file gets a text (Semaphore, Twilio or your own gateway) and parents with the app get a push notification.
4. The dashboard updates live. Unregistered cards show up under **Cards**, ready to assign.

Readers that lose the internet keep the taps with their time and send them when the connection is back.

## Run it

Needs Node.js 22.13 or newer.

```bash
npm install
cp .env.example .env      # optional, every setting has a default
npm run seed              # optional: 8 demo students, parents, a "Main Gate" reader and a week of taps
npm start
```

- Website: http://localhost:3000/
- Dashboard: http://localhost:3000/admin/ — on the first start the admin username and password are printed in the terminal (or set `ADMIN_PASSWORD` in `.env`)
- App: http://localhost:3000/app/

With `SMS_PROVIDER=console` (the default) texts are printed in the terminal instead of being sent.

Run the tests with `npm test`.

## Put it in the cloud

The whole system is one Node.js server with an SQLite database file, so it runs on any host with a persistent disk. Phones need **HTTPS** for NFC, notifications and installing the app; cloud hosts provide it.

**Render (simplest):** push this repository to GitHub, then in Render choose **New → Blueprint** and pick the repository. `render.yaml` creates the server with a 1 GB disk for the database. Fill in `ADMIN_PASSWORD`, `PUBLIC_URL` (your Render address) and the SMS settings.

**Any server with Docker:**

```bash
docker build -t nfc-attendance .
docker run -d -p 3000:3000 -v nfc-data:/data --env-file .env nfc-attendance
```

Put it behind a reverse proxy with HTTPS (Caddy, Nginx) and set `TRUST_PROXY=1`.

Back up the database by copying the `data/` folder (or `/data` on the server).

## Text messages to parents

Set `SMS_PROVIDER` in `.env`:

| Value | Service | Settings |
| --- | --- | --- |
| `semaphore` | [Semaphore](https://semaphore.co) (Philippines) | `SEMAPHORE_API_KEY`, optional `SEMAPHORE_SENDER_NAME` |
| `twilio` | Twilio | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` |
| `webhook` | Your own SMS gateway | `SMS_WEBHOOK_URL` receives `POST {"to": "+639…", "message": "…"}`; optional `SMS_WEBHOOK_TOKEN` is sent as a Bearer token |
| `console` | None (testing) | Messages are printed in the server log |
| `none` | Off | |

Check it in **Settings → Send test text**. Every message and its delivery status is listed under **Messages**, where failed ones can be resent. The wording is editable in **Settings** using `{school} {student} {first_name} {last_name} {grade} {section} {time} {date} {gate}`.

## App notifications to parents

Works with no setup: the server makes its own Web Push keys and keeps them in the database. To use your own, set `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (`npx web-push generate-vapid-keys`) and `VAPID_SUBJECT` to a real `mailto:` address.

Parents:

1. The school adds the parent's mobile number to the student (or imports it from CSV) and presses **Text app invite**. The parent gets the app link and an 8-letter code.
2. The parent opens `/app/`, chooses **I'm a parent**, enters their number, the code and a new password.
3. They press **Turn on notifications**. On iPhone, add the app to the Home Screen first (Share → Add to Home Screen) — Apple only allows notifications for installed apps.

Forgot password: press **New code** and **Text app invite** again; activating with the new code sets a new password.

## Gate readers

Create a reader in **Dashboard → Gate readers → Add reader**. You get a pairing link and a reader key. Mode can be **Auto** (IN then OUT), **Entrance only** or **Exit only** — use the last two when there are separate entry and exit gates.

### Android phone or tablet (built-in NFC)

Open the pairing link in **Chrome on Android**, tap **Start NFC** once and allow NFC. Leave the screen on the gate; it stays awake, beeps, and shows the student's name with a green (IN) or orange (OUT) screen. Add it to the home screen to run it full screen.

### USB NFC reader on a computer

- **Readers that type like a keyboard** (most cheap 13.56 MHz USB readers): open the pairing link in any browser on the computer. Taps are read from the keyboard input. Set the reader to output the card ID in **hex** if it has the option; 10-digit decimal output is also recognised.
- **ACR122U and other PC/SC readers**: use the bridge.

  ```bash
  pip install pyscard
  python bridge/pcsc_bridge.py --server https://your-server --key dev_xxxxx
  ```

### ESP32 + RC522 wall reader

`firmware/esp32_rc522/esp32_rc522.ino` — a cheap standalone reader with a buzzer and green/yellow/red lights. Wiring is at the top of the file. Install the **MFRC522** library in the Arduino IDE, fill in Wi-Fi, `SERVER_URL` and `DEVICE_KEY`, and upload to an "ESP32 Dev Module". It keeps up to 100 taps with their time while Wi-Fi is down.

## Registering cards

- **One by one:** open a student → **Assign card**. Click in the box and tap the card on a USB reader, press **Scan with phone** on Android, or type the ID.
- **From the gate:** tap new cards on any gate reader. They appear under **Cards → Unregistered cards**; press **Assign** and pick the student.
- **In bulk:** **Students → Import CSV** with the columns
  `student_no, first_name, last_name, grade, section, card_uid, guardian_name, guardian_relationship, guardian_phone`
  (only the first three are required; a template can be downloaded in the dialog).

Card IDs are stored as hex without separators, e.g. `04A23B91`.

## Reports

- **Today:** present, on campus now, already left, late, not yet in; live list of taps; reader status.
- **Daily report:** each student's status (present / late / absent), first IN and last OUT for any date, filter by grade and section, export to CSV.
- **Attendance log:** every tap in a date range, export to CSV.
- **Late after** and the repeat-tap window are in **Settings**.

## Reader API

For your own hardware:

```
POST /api/tap
X-Device-Key: dev_xxxxx
Content-Type: application/json

{"uid": "04A23B91"}                      // live tap
{"uid": "04A23B91", "at": 1793000000}    // saved offline: Unix seconds, ms or ISO time (up to 7 days old)
```

Response (always HTTP 200 for a readable card):

```json
{"status": "ok", "direction": "IN", "time": "7:12 AM", "student": {"name": "Juan Dela Cruz", "grade": "Grade 10", "section": "Rizal"}, "message": "Welcome, Juan!"}
```

`status` is `ok`, `duplicate` (already recorded within the repeat-tap window), `unknown` (card not registered) or `inactive` (student turned off). HTTP 401 means the key is wrong or the reader was turned off.

## Project layout

```
server/            Node.js + Express API, SQLite database (node:sqlite)
  app.js           server setup, security headers, first admin account
  attendance.js    tap logic: IN/OUT, repeat taps, offline times, reports
  notify.js        parent texts and app notifications, saved with delivery status
  sms.js           Semaphore, Twilio, webhook and console providers
  push.js          Web Push
  routes/          API endpoints
  seed.js          demo data
public/
  index.html       website
  admin/           school dashboard
  app/             installable app: parent view and gate reader (service worker, manifest)
firmware/          ESP32 + RC522 reader
bridge/            ACR122U / PC/SC USB reader bridge
test/              npm test
```

## Database

| Table | Holds |
| --- | --- |
| `students` | student number, name, grade, section, card ID, active |
| `guardians` | parents per student, mobile number, texts on/off, app code |
| `attendance` | every IN/OUT: student, time, school-day date, gate, card or manual, who recorded it |
| `devices` | gate readers, mode, hashed key, last seen |
| `notifications` | every text and app notification with status and error |
| `users` | admin, staff and parent accounts (scrypt-hashed passwords) |
| `push_subscriptions` | parents' phones with notifications on |
| `unknown_taps` | cards tapped that are not registered yet |
| `settings` | school name, time zone, late time, message wording |
