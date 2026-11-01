/*
 * 照片库总览 —— 外接 OLED 显示局域网 IP
 * ------------------------------------------------------------------
 * 硬件：ESP32 或 ESP8266 开发板 + SSD1306 128x64 I2C OLED
 * 接线（4 根线）：
 *
 *   OLED   VCC -> 3V3
 *   OLED   GND -> GND
 *   OLED   SDA -> 见下表
 *   OLED   SCL -> 见下表
 *
 *   板子              SDA        SCL
 *   ESP32 (DevKit)    21         22
 *   ESP32-C3 SuperMini 8          9      <= 注意 C3 不是 21/22
 *   ESP8266 (NodeMCU) D2(GPIO4)  D1(GPIO5)
 *
 * 依赖库（Arduino IDE → 库管理器 → 搜 U8g2 → 安装 "U8g2" by oliver）
 * 开发板管理器里装 esp32 或 esp8266 支持包后，直接按对应板子选型号上传。
 *
 * 协议：PC 端每 30 秒发一行（\n 结尾），字段用 | 分隔，最多 4 段：
 *   F|192.168.3.102|:7788|864 GiB / 114 dirs|
 *   第 0 段放大显示（IP），其余三行小字。
 * 60 秒没收到数据就显示 WAITING...
 * ------------------------------------------------------------------
 */

#include <Wire.h>
#include <U8g2lib.h>

// ---- 按你的板子改这里 -------------------------------------------------
#if defined(ESP8266)
  #define PIN_SDA 4        // D2
  #define PIN_SCL 5        // D1
  U8G2_SSD1306_128X64_NONAME_F_SW_I2C u8g2(U8G2_R0, PIN_SCL, PIN_SDA, U8X8_PIN_NONE);
#elif defined(CONFIG_IDF_TARGET_ESP32C3) || defined(ARDUINO_ESP32C3_DEV)
  #define PIN_SDA 8
  #define PIN_SCL 9
  // C3 的 I2C 不是 21/22，必须显式指定 clock/data
  U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE, PIN_SCL, PIN_SDA);
#else   // 经典 ESP32
  #define PIN_SDA 21
  #define PIN_SCL 22
  U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE, PIN_SCL, PIN_SDA);
#endif

// ---- 状态 -------------------------------------------------------------
String fields[4] = { "", "", "", "" };
unsigned long lastRx = 0;
bool dirty = true;
const unsigned long TIMEOUT_MS = 60000;
String rxLine = "";

void setup() {
  Serial.begin(115200);
  // ESP32 的硬件 I2C 引脚已通过 u8g2 构造函数传入；ESP8266 走软件 I2C，无需 Wire
#if !defined(ESP8266)
  u8g2.setBusClock(400000);
#endif
  u8g2.begin();
  u8g2.setContrast(180);       // 0-255，太亮刺眼可以调小
  u8g2.clearBuffer();
  u8g2.setFont(u8g2_font_6x10_tf);
  u8g2.drawStr(0, 12, "OUTPUT WebViewer");
  u8g2.drawStr(0, 28, "waiting for PC...");
  u8g2.sendBuffer();
}

void draw() {
  u8g2.clearBuffer();

  if (millis() - lastRx > TIMEOUT_MS) {
    u8g2.setFont(u8g2_font_6x10_tf);
    u8g2.drawStr(0, 12, "OUTPUT WebViewer");
    u8g2.setFont(u8g2_font_9x15B_tf);
    u8g2.drawStr(0, 36, "WAITING...");
    u8g2.setFont(u8g2_font_6x10_tf);
    u8g2.drawStr(0, 56, "PC not sending data");
    u8g2.sendBuffer();
    return;
  }

  // 第 0 行：小标签
  u8g2.setFont(u8g2_font_6x10_tf);
  u8g2.drawStr(0, 9, "LAN");

  // 第 1 行：IP，大字号
  u8g2.setFont(u8g2_font_9x15B_tf);
  u8g2.drawStr(0, 28, fields[0].c_str());

  // 第 2、3 行：端口 / 统计
  u8g2.setFont(u8g2_font_6x10_tf);
  u8g2.drawStr(0, 43, fields[1].c_str());
  u8g2.drawStr(0, 56, fields[2].c_str());
  if (fields[3].length()) u8g2.drawStr(0, 56, fields[3].c_str());

  u8g2.sendBuffer();
}

void loop() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (rxLine.length() > 0) parseLine(rxLine);
      rxLine = "";
    } else if (rxLine.length() < 120) {
      rxLine += c;
    }
  }

  if (dirty) { draw(); dirty = false; }
  if (millis() - lastRx > TIMEOUT_MS && !dirty) { draw(); delay(500); }  // 超时后每 0.5s 重画一次
  delay(10);
}

void parseLine(String line) {
  if (!line.startsWith("F|")) return;      // 只认帧
  lastRx = millis();
  int idx = 0;
  int start = 2;
  for (int i = 2; i <= (int)line.length() && idx < 4; i++) {
    if (i == (int)line.length() || line[i] == '|') {
      fields[idx++] = line.substring(start, i);
      start = i + 1;
    }
  }
  dirty = true;
}
