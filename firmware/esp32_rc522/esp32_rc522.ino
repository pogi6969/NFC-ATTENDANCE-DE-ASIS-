// NFC gate reader: ESP32 + MFRC522 (RC522) module.
// A student taps their card, the reader sends the card ID to the attendance server,
// and the green (IN) or yellow (OUT) light and the buzzer confirm it.
// Taps made while Wi-Fi is down are kept with their time and sent later.
//
// Libraries (Arduino Library Manager): "MFRC522" by GithubCommunity (miguelbalboa)
// Board: "ESP32 Dev Module" (Espressif ESP32 core)
//
// Wiring (RC522 -> ESP32):  SDA/SS -> GPIO 5, SCK -> 18, MOSI -> 23, MISO -> 19,
//                           RST -> 22, 3.3V -> 3V3, GND -> GND
// Green LED -> GPIO 25, Yellow LED -> GPIO 26, Red LED -> GPIO 27 (each with a 220 ohm resistor)
// Active buzzer -> GPIO 4

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <SPI.h>
#include <MFRC522.h>
#include <time.h>

// ---------- Change these ----------
const char* WIFI_SSID = "School-WiFi";
const char* WIFI_PASSWORD = "wifi-password";
// Your server address, no slash at the end, e.g. https://attendance.yourschool.edu.ph
const char* SERVER_URL = "https://your-server.example.com";
// Dashboard -> Gate readers -> Add reader -> reader key
const char* DEVICE_KEY = "dev_paste_the_reader_key_here";
// ----------------------------------

const int PIN_SS = 5;
const int PIN_RST = 22;
const int PIN_GREEN = 25;
const int PIN_YELLOW = 26;
const int PIN_RED = 27;
const int PIN_BUZZER = 4;

const int QUEUE_SIZE = 100;
struct Tap {
  char uid[21];
  time_t at;
};
Tap queue[QUEUE_SIZE];
int queueCount = 0;

MFRC522 rfid(PIN_SS, PIN_RST);
String lastUid = "";
unsigned long lastTapMs = 0;
unsigned long lastSyncMs = 0;

void beep(int times, int ms) {
  for (int i = 0; i < times; i++) {
    digitalWrite(PIN_BUZZER, HIGH);
    delay(ms);
    digitalWrite(PIN_BUZZER, LOW);
    if (i < times - 1) delay(80);
  }
}

void flash(int pin, int ms) {
  digitalWrite(pin, HIGH);
  delay(ms);
  digitalWrite(pin, LOW);
}

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 10000) delay(250);
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("Wi-Fi connected, IP %s\n", WiFi.localIP().toString().c_str());
    configTime(0, 0, "pool.ntp.org", "time.google.com");
  } else {
    Serial.println("Wi-Fi not connected, taps will be saved and sent later");
  }
}

bool clockReady() {
  return time(nullptr) > 1700000000;  // NTP has set the clock
}

// Returns the HTTP status (0 when the server could not be reached) and fills `body`.
int postTap(const char* uid, time_t at, String& body) {
  if (WiFi.status() != WL_CONNECTED) return 0;
  WiFiClientSecure secure;
  WiFiClient plain;
  HTTPClient http;
  String url = String(SERVER_URL) + "/api/tap";
  bool ok;
  if (url.startsWith("https")) {
    secure.setInsecure();  // Skips certificate checks. Use secure.setCACert(...) for a pinned certificate.
    ok = http.begin(secure, url);
  } else {
    ok = http.begin(plain, url);
  }
  if (!ok) return 0;
  http.setTimeout(8000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", DEVICE_KEY);
  String json = String("{\"uid\":\"") + uid + "\"";
  if (at > 0) json += String(",\"at\":") + String((long)at);
  json += "}";
  int status = http.POST(json);
  body = status > 0 ? http.getString() : "";
  http.end();
  return status > 0 ? status : 0;
}

void enqueue(const char* uid) {
  if (queueCount == QUEUE_SIZE) {
    memmove(&queue[0], &queue[1], sizeof(Tap) * (QUEUE_SIZE - 1));
    queueCount--;
  }
  strncpy(queue[queueCount].uid, uid, sizeof(queue[queueCount].uid) - 1);
  queue[queueCount].uid[sizeof(queue[queueCount].uid) - 1] = 0;
  queue[queueCount].at = clockReady() ? time(nullptr) : 0;
  queueCount++;
  Serial.printf("Saved offline (%d waiting)\n", queueCount);
}

void syncQueue() {
  while (queueCount > 0) {
    String body;
    int status = postTap(queue[0].uid, queue[0].at, body);
    if (status == 0 || status >= 500 || status == 401) return;  // try again later
    memmove(&queue[0], &queue[1], sizeof(Tap) * (queueCount - 1));
    queueCount--;
    Serial.printf("Synced an offline tap (%d left)\n", queueCount);
  }
}

void showResult(int status, const String& body) {
  if (status == 200 && body.indexOf("\"status\":\"ok\"") >= 0) {
    bool in = body.indexOf("\"direction\":\"IN\"") >= 0;
    Serial.println(in ? "IN" : "OUT");
    beep(1, 120);
    flash(in ? PIN_GREEN : PIN_YELLOW, 1500);
  } else if (status == 200 && body.indexOf("\"status\":\"duplicate\"") >= 0) {
    Serial.println("Already recorded");
    beep(2, 60);
    flash(PIN_GREEN, 400);
  } else {
    Serial.printf("Not recorded (HTTP %d): %s\n", status, body.c_str());
    beep(3, 150);
    flash(PIN_RED, 1500);
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_GREEN, OUTPUT);
  pinMode(PIN_YELLOW, OUTPUT);
  pinMode(PIN_RED, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  SPI.begin();
  rfid.PCD_Init();
  Serial.println("NFC gate reader starting");
  connectWiFi();
  beep(1, 60);
}

void loop() {
  if (millis() - lastSyncMs > 15000) {
    lastSyncMs = millis();
    connectWiFi();
    syncQueue();
  }

  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) {
    delay(30);
    return;
  }

  char uid[21] = {0};
  for (byte i = 0; i < rfid.uid.size && i < 10; i++) sprintf(uid + i * 2, "%02X", rfid.uid.uidByte[i]);
  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();

  // The same card held on the reader is read many times; count it once every 3 seconds.
  if (lastUid == uid && millis() - lastTapMs < 3000) return;
  lastUid = uid;
  lastTapMs = millis();
  Serial.printf("Card %s\n", uid);

  String body;
  int status = postTap(uid, 0, body);
  if (status == 0 || status >= 500) {
    enqueue(uid);
    beep(1, 120);
    flash(PIN_YELLOW, 300);
    flash(PIN_GREEN, 300);
    return;
  }
  showResult(status, body);
}
