package app.nfcattendance.gate;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

import org.json.JSONException;
import org.json.JSONObject;

/** Talks to the attendance server's reader API with the reader key. */
final class Api {
    static final class Response {
        final int status;
        final JSONObject json;

        Response(int status, JSONObject json) {
            this.status = status;
            this.json = json;
        }

        String error() {
            return json.optString("error", "Server error " + status);
        }
    }

    private Api() {}

    /** Throws IOException when the server cannot be reached (no internet). */
    static Response request(String server, String key, String method, String path, JSONObject body) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(server + path).openConnection();
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(10000);
        conn.setRequestMethod(method);
        conn.setRequestProperty("X-Device-Key", key);
        conn.setRequestProperty("Accept", "application/json");
        try {
            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream out = conn.getOutputStream()) {
                    out.write(bytes);
                }
            }
            int status = conn.getResponseCode();
            InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String text = in == null ? "" : readAll(in);
            JSONObject json;
            try {
                json = text.isEmpty() ? new JSONObject() : new JSONObject(text);
            } catch (JSONException e) {
                if (status < 400) throw new IOException("The server address does not look right.");
                json = new JSONObject();
            }
            return new Response(status, json);
        } finally {
            conn.disconnect();
        }
    }

    private static String readAll(InputStream in) throws IOException {
        try (InputStream input = in) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int n;
            while ((n = input.read(chunk)) > 0) buf.write(chunk, 0, n);
            return buf.toString("UTF-8");
        }
    }
}
