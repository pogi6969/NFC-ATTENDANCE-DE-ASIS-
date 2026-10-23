package app.nfcattendance.gate;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.nfc.NfcAdapter;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Pairs the phone with a gate reader created in the school dashboard. */
public class SetupActivity extends Activity {
    static final String EXTRA_MESSAGE = "message";

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler ui = new Handler(Looper.getMainLooper());
    private Store store;
    private TextView message;
    private EditText linkField;
    private EditText keyField;
    private Button pairButton;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        store = new Store(this);
        if (store.paired() && getIntent().getStringExtra(EXTRA_MESSAGE) == null) {
            openGate();
            return;
        }
        buildUi();
        if (NfcAdapter.getDefaultAdapter(this) == null) {
            showMessage("This phone has no NFC. Use an Android phone with NFC as the gate reader.", true);
            pairButton.setEnabled(false);
        }
        String msg = getIntent().getStringExtra(EXTRA_MESSAGE);
        if (msg != null) showMessage(msg, true);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        worker.shutdownNow();
    }

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    private TextView text(String s, int sizeSp, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sizeSp);
        t.setTextColor(Color.WHITE);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setPadding(0, dp(6), 0, dp(6));
        return t;
    }

    private EditText input(String hint, String value) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setText(value);
        e.setSingleLine(true);
        e.setTextColor(Color.WHITE);
        e.setHintTextColor(0x99FFFFFF);
        e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        return e;
    }

    private void buildUi() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(24), dp(40), dp(24), dp(24));

        box.addView(text("NFC Gate", 30, true));
        box.addView(text("Turns this phone into the NFC reader at the campus gate. Students tap their NFC-tagged ID on the back of the phone.", 16, false));
        box.addView(text("1. In the school dashboard open Gate readers → Add reader.\n2. Copy the pairing link and paste it below.", 15, false));

        linkField = input("Pairing link, e.g. https://school.example.com/app/#gate/pair/dev_…", store.server());
        box.addView(linkField);
        box.addView(text("Or paste the server address above and the reader key here:", 14, false));
        keyField = input("Reader key (dev_…)", "");
        box.addView(keyField);

        pairButton = new Button(this);
        pairButton.setText("Pair this phone");
        pairButton.setOnClickListener(v -> pair());
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(16);
        box.addView(pairButton, lp);

        message = text("", 15, true);
        message.setGravity(Gravity.START);
        box.addView(message);

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(0xFF0E2F73);
        scroll.setFillViewport(true);
        scroll.addView(box);
        setContentView(scroll);
        getWindow().setStatusBarColor(0xFF0E2F73);
    }

    private void showMessage(String s, boolean error) {
        message.setText(s);
        message.setTextColor(error ? 0xFFFFB4AB : 0xFFB7F5D0);
    }

    private void pair() {
        String link = linkField.getText().toString().trim();
        String key = keyField.getText().toString().trim();
        String server = link;
        int marker = link.indexOf("#gate/pair/");
        if (marker >= 0) {
            key = Uri.decode(link.substring(marker + "#gate/pair/".length())).trim();
            Uri uri = Uri.parse(link);
            server = uri.getScheme() + "://" + uri.getEncodedAuthority();
        }
        if (!server.startsWith("http://") && !server.startsWith("https://")) server = "https://" + server;
        while (server.endsWith("/")) server = server.substring(0, server.length() - 1);
        if (server.endsWith("/app")) server = server.substring(0, server.length() - 4);
        if (key.isEmpty()) {
            showMessage("Paste the pairing link, or the server address and the reader key.", true);
            return;
        }

        final String s = server;
        final String k = key;
        pairButton.setEnabled(false);
        showMessage("Checking…", false);
        worker.submit(() -> {
            String error = null;
            try {
                Api.Response r = Api.request(s, k, "GET", "/api/device/me", null);
                if (r.status == 200) {
                    store.pair(s, k);
                    store.saveDevice(r.json);
                } else {
                    error = r.error();
                }
            } catch (IOException e) {
                error = "Cannot reach " + s + ". Check the address and the internet connection.";
            }
            final String err = error;
            ui.post(() -> {
                pairButton.setEnabled(true);
                if (err != null) {
                    showMessage(err, true);
                } else {
                    openGate();
                }
            });
        });
    }

    private void openGate() {
        startActivity(new Intent(this, GateActivity.class));
        finish();
    }
}
