package app.nfcattendance.gate;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.nfc.NfcAdapter;
import android.nfc.Tag;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.os.Vibrator;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Full-screen gate reader: students tap their NFC-tagged ID on the back of the phone. */
public class GateActivity extends Activity implements NfcAdapter.ReaderCallback {
    private static final int BLUE = 0xFF0E2F73;
    private static final int GREEN = 0xFF0B6B3C;
    private static final int ORANGE = 0xFF8A3F05;
    private static final int RED = 0xFF9B1C13;
    private static final int GREY = 0xFF3D4C6B;
    private static final int READER_FLAGS = NfcAdapter.FLAG_READER_NFC_A | NfcAdapter.FLAG_READER_NFC_B
            | NfcAdapter.FLAG_READER_NFC_F | NfcAdapter.FLAG_READER_NFC_V
            | NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK | NfcAdapter.FLAG_READER_NO_PLATFORM_SOUNDS;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService taps = Executors.newSingleThreadExecutor();
    private Store store;
    private NfcAdapter nfc;
    private ToneGenerator tone;
    private SimpleDateFormat clockFormat;
    private SimpleDateFormat timeFormat;

    private FrameLayout root;
    private TextView header;
    private TextView clock;
    private TextView prompt;
    private TextView big;
    private TextView badge;
    private TextView detail;
    private TextView status;
    private Button nfcButton;

    private String lastUid = "";
    private long lastTapMs;
    private boolean online = true;
    private boolean syncing;

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            clock.setText(clockFormat.format(new Date()));
            ui.postDelayed(this, 1000);
        }
    };

    private final Runnable syncLoop = new Runnable() {
        @Override
        public void run() {
            taps.submit(GateActivity.this::sync);
            ui.postDelayed(this, 15000);
        }
    };

    private final Runnable reset = this::showIdle;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        store = new Store(this);
        if (!store.paired()) {
            backToSetup(null);
            return;
        }
        nfc = NfcAdapter.getDefaultAdapter(this);
        try {
            tone = new ToneGenerator(AudioManager.STREAM_MUSIC, 100);
        } catch (RuntimeException ignored) {
            tone = null;
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        buildUi();
        applyDevice(store.device());
        showIdle();
        taps.submit(this::refreshDevice);
    }

    @Override
    protected void onResume() {
        super.onResume();
        hideSystemBars();
        ui.post(tick);
        ui.post(syncLoop);
        startReader();
    }

    @Override
    protected void onPause() {
        super.onPause();
        ui.removeCallbacks(tick);
        ui.removeCallbacks(syncLoop);
        if (nfc != null) nfc.disableReaderMode(this);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        taps.shutdownNow();
        if (tone != null) tone.release();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    // ---------- NFC ----------

    private void startReader() {
        if (nfc == null) {
            nfcButton.setVisibility(View.GONE);
            setStatus();
            return;
        }
        if (!nfc.isEnabled()) {
            nfcButton.setVisibility(View.VISIBLE);
            setStatus();
            return;
        }
        nfcButton.setVisibility(View.GONE);
        Bundle extras = new Bundle();
        extras.putInt(NfcAdapter.EXTRA_READER_PRESENCE_CHECK_DELAY, 250);
        nfc.enableReaderMode(this, this, READER_FLAGS, extras);
        setStatus();
    }

    @Override
    public void onTagDiscovered(Tag tag) {
        byte[] id = tag.getId();
        if (id == null || id.length == 0) return;
        StringBuilder sb = new StringBuilder();
        for (byte b : id) sb.append(String.format(Locale.US, "%02X", b));
        String uid = sb.toString();
        long now = SystemClock.elapsedRealtime();
        if (uid.equals(lastUid) && now - lastTapMs < 3000) return;
        lastUid = uid;
        lastTapMs = now;
        taps.submit(() -> send(uid));
    }

    // ---------- Server ----------

    private void send(String uid) {
        try {
            JSONObject body = new JSONObject().put("uid", uid);
            Api.Response r = Api.request(store.server(), store.key(), "POST", "/api/tap", body);
            online = true;
            if (r.status == 401) {
                ui.post(() -> backToSetup(r.error()));
                return;
            }
            ui.post(() -> showResult(r));
        } catch (IOException e) {
            online = false;
            store.enqueue(uid, System.currentTimeMillis() / 1000);
            ui.post(() -> show(GREY, "Tap saved", null, "No internet — it will be sent automatically.", ToneGenerator.TONE_PROP_ACK));
        } catch (JSONException ignored) {
            // cannot happen: building {"uid": "..."}
        }
    }

    private void sync() {
        if (syncing) return;
        syncing = true;
        try {
            JSONArray q = store.queue();
            while (q.length() > 0) {
                JSONObject tap = q.getJSONObject(0);
                Api.Response r;
                try {
                    r = Api.request(store.server(), store.key(), "POST", "/api/tap", tap);
                    online = true;
                } catch (IOException e) {
                    online = false;
                    break;
                }
                if (r.status == 401 || r.status >= 500) break;
                store.dropFirst(); // sent, or refused for good (e.g. older than 7 days)
                q = store.queue();
            }
        } catch (JSONException e) {
            store.dropFirst();
        } finally {
            syncing = false;
            ui.post(this::setStatus);
        }
    }

    private void refreshDevice() {
        try {
            Api.Response r = Api.request(store.server(), store.key(), "GET", "/api/device/me", null);
            online = true;
            if (r.status == 401) {
                ui.post(() -> backToSetup(r.error()));
            } else if (r.status == 200) {
                store.saveDevice(r.json);
                ui.post(() -> applyDevice(r.json));
            }
        } catch (IOException e) {
            online = false;
        }
        ui.post(this::setStatus);
    }

    // ---------- Screen ----------

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    private TextView label(float sp, boolean bold) {
        TextView t = new TextView(this);
        t.setTextColor(Color.WHITE);
        t.setTextSize(sp);
        t.setGravity(Gravity.CENTER);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private void buildUi() {
        root = new FrameLayout(this);
        root.setBackgroundColor(BLUE);

        header = label(15, true);
        header.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        header.setPadding(dp(16), dp(12), dp(16), dp(12));
        header.setOnLongClickListener(v -> {
            showMenu();
            return true;
        });
        root.addView(header, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP));

        LinearLayout center = new LinearLayout(this);
        center.setOrientation(LinearLayout.VERTICAL);
        center.setGravity(Gravity.CENTER);
        center.setPadding(dp(16), 0, dp(16), 0);
        clock = label(56, true);
        badge = label(30, true);
        GradientDrawable pill = new GradientDrawable();
        pill.setCornerRadius(dp(40));
        pill.setColor(0x33FFFFFF);
        badge.setBackground(pill);
        badge.setPadding(dp(28), dp(6), dp(28), dp(6));
        big = label(40, true);
        prompt = label(22, false);
        detail = label(18, false);
        center.addView(clock);
        center.addView(badge, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        center.addView(big);
        center.addView(prompt);
        center.addView(detail);
        nfcButton = new Button(this);
        nfcButton.setText("Turn on NFC");
        nfcButton.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_NFC_SETTINGS)));
        nfcButton.setVisibility(View.GONE);
        center.addView(nfcButton);
        root.addView(center, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        status = label(13, false);
        status.setPadding(dp(16), dp(10), dp(16), dp(16));
        status.setAlpha(0.85f);
        root.addView(status, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM));

        setContentView(root);
    }

    private void applyDevice(JSONObject me) {
        JSONObject device = me.optJSONObject("device");
        String mode = device == null ? "auto" : device.optString("mode", "auto");
        String modeText = "in".equals(mode) ? "Entrance — IN" : "out".equals(mode) ? "Exit — OUT" : "IN / OUT";
        String name = device == null ? "Gate" : device.optString("name", "Gate");
        header.setText(me.optString("school_name", "") + "   " + name + " · " + modeText);
        TimeZone tz = TimeZone.getTimeZone(me.optString("timezone", TimeZone.getDefault().getID()));
        clockFormat = new SimpleDateFormat("h:mm:ss a", Locale.US);
        clockFormat.setTimeZone(tz);
        timeFormat = new SimpleDateFormat("h:mm a", Locale.US);
        timeFormat.setTimeZone(tz);
    }

    private void setStatus() {
        String reader = nfc == null ? "No NFC on this phone" : nfc.isEnabled() ? "NFC on" : "NFC is off";
        int waiting = store.queue().length();
        status.setText(reader + "   ·   " + (online ? "Online" : "Offline")
                + (waiting > 0 ? "   ·   " + waiting + " waiting to sync" : "")
                + "\nHold the top bar for options");
    }

    private void showIdle() {
        root.setBackgroundColor(BLUE);
        clock.setVisibility(View.VISIBLE);
        badge.setVisibility(View.GONE);
        big.setVisibility(View.GONE);
        prompt.setText("Tap your ID on the back of this phone");
        detail.setText("");
    }

    private void show(int color, String title, String badgeText, String line, int toneType) {
        ui.removeCallbacks(reset);
        root.setBackgroundColor(color);
        clock.setVisibility(View.GONE);
        badge.setVisibility(badgeText == null ? View.GONE : View.VISIBLE);
        badge.setText(badgeText == null ? "" : badgeText);
        big.setVisibility(View.VISIBLE);
        big.setText(title);
        prompt.setText(line);
        detail.setText("");
        beep(toneType, color == RED);
        setStatus();
        ui.postDelayed(reset, color == RED ? 5000 : 3500);
    }

    private void showResult(Api.Response r) {
        JSONObject j = r.json;
        String state = j.optString("status");
        JSONObject student = j.optJSONObject("student");
        String name = student == null ? "" : student.optString("name");
        if (r.status != 200) {
            show(RED, "Not recorded", null, r.error(), ToneGenerator.TONE_SUP_ERROR);
        } else if ("ok".equals(state)) {
            boolean in = "IN".equals(j.optString("direction"));
            show(in ? GREEN : ORANGE, name, in ? "IN" : "OUT", j.optString("message") + " · " + j.optString("time"), ToneGenerator.TONE_PROP_ACK);
            if (student != null) {
                String section = student.optString("section");
                detail.setText((student.optString("grade") + (section.isEmpty() ? "" : " · " + section)).trim());
            }
        } else if ("duplicate".equals(state)) {
            show(GREY, name, null, j.optString("message"), ToneGenerator.TONE_PROP_BEEP2);
        } else if ("unknown".equals(state)) {
            show(RED, "Card not registered", null, j.optString("message"), ToneGenerator.TONE_SUP_ERROR);
            detail.setText(j.optString("uid"));
        } else {
            show(RED, name.isEmpty() ? "Card turned off" : name, null, j.optString("message"), ToneGenerator.TONE_SUP_ERROR);
        }
    }

    @SuppressWarnings("deprecation")
    private void beep(int toneType, boolean error) {
        if (tone != null) tone.startTone(toneType, error ? 600 : 200);
        Vibrator v = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
        if (v != null && v.hasVibrator()) {
            if (error) v.vibrate(new long[] {0, 80, 60, 80}, -1);
            else v.vibrate(60);
        }
    }

    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
    }

    private void showMenu() {
        new AlertDialog.Builder(this)
                .setTitle("Gate reader")
                .setMessage("Server: " + store.server()
                        + "\n\nTo keep students from leaving this screen, turn on App pinning in the phone's Settings → Security, then pin this app.")
                .setPositiveButton("Close", null)
                .setNeutralButton("Reload", (d, w) -> taps.submit(this::refreshDevice))
                .setNegativeButton("Unpair", (d, w) -> new AlertDialog.Builder(this)
                        .setMessage("Unpair this phone? You will need the pairing link again.")
                        .setPositiveButton("Unpair", (d2, w2) -> {
                            store.unpair();
                            backToSetup("Unpaired. Paste a pairing link to set up again.");
                        })
                        .setNegativeButton("Cancel", null)
                        .show())
                .show();
    }

    private void backToSetup(String message) {
        if (message != null) store.unpair();
        Intent i = new Intent(this, SetupActivity.class);
        if (message != null) i.putExtra(SetupActivity.EXTRA_MESSAGE, message);
        startActivity(i);
        finish();
    }
}
