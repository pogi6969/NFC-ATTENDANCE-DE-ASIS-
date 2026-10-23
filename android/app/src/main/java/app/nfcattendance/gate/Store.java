package app.nfcattendance.gate;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Saved pairing and the taps waiting to be sent while offline. */
final class Store {
    private static final int MAX_QUEUE = 2000;
    private final SharedPreferences prefs;

    Store(Context context) {
        prefs = context.getSharedPreferences("gate", Context.MODE_PRIVATE);
    }

    String server() {
        return prefs.getString("server", "");
    }

    String key() {
        return prefs.getString("key", "");
    }

    boolean paired() {
        return !server().isEmpty() && !key().isEmpty();
    }

    void pair(String server, String key) {
        prefs.edit().putString("server", server).putString("key", key).apply();
    }

    void unpair() {
        prefs.edit().remove("key").remove("device").apply();
    }

    void saveDevice(JSONObject me) {
        prefs.edit().putString("device", me.toString()).apply();
    }

    JSONObject device() {
        try {
            return new JSONObject(prefs.getString("device", "{}"));
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    synchronized JSONArray queue() {
        try {
            return new JSONArray(prefs.getString("queue", "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    synchronized void enqueue(String uid, long epochSeconds) {
        JSONArray q = queue();
        try {
            q.put(new JSONObject().put("uid", uid).put("at", epochSeconds));
        } catch (JSONException ignored) {
            return;
        }
        while (q.length() > MAX_QUEUE) q.remove(0);
        prefs.edit().putString("queue", q.toString()).apply();
    }

    synchronized void dropFirst() {
        JSONArray q = queue();
        if (q.length() > 0) q.remove(0);
        prefs.edit().putString("queue", q.toString()).apply();
    }
}
