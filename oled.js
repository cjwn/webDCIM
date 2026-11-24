#!/usr/bin/env node
/**
 * 把"局域网 IP + 相册统计"推到外接 OLED 上显示
 * ------------------------------------------------------------------
 * 用法：
 *   node oled.js                    # 自动找串口
 *   node oled.js --com COM7         # 指定串口
 *   node oled.js --dry-run          # 不连硬件，只打印将要发送的内容（调试用）
 *
 * 环境变量：
 *   OLED_COM=COM7       串口名
 *   OLED_BAUD=115200    波特率（要和固件里 Serial.begin 一致）
 *   API=http://127.0.0.1:7788   从哪个实例取数据
 *
 * 依赖：npm i serialport   （只有真正驱动屏幕时才需要，--dry-run 不需要）
 */
'use strict';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : null;
};
const DRY = args.includes('--dry-run');
const API = process.env.API || 'http://127.0.0.1:7788';
const BAUD = Number(process.env.OLED_BAUD || 115200);
const WANT_COM = argOf('com') || process.env.OLED_COM || null;
const INTERVAL = 30000;

let port = null;
let lastFrame = '';

const fmtSize = (b) => {
  if (!b) return '0 B';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0, v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)) + ' ' + u[i];
};

async function pickPort() {
  const { SerialPort } = require('serialport');
  const list = await SerialPort.list();
  const usable = list.filter((p) => !/蓝牙|Bluetooth|debug-console/i.test((p.path || '') + ' ' + (p.friendlyName || '') + ' ' + (p.manufacturer || '')));
  if (WANT_COM) {
    const hit = list.find((p) => (p.path || '').toUpperCase() === WANT_COM.toUpperCase());
    if (!hit) throw new Error(`找不到串口 ${WANT_COM}，可用：${list.map((p) => p.path).join(', ') || '(无)'}`);
    return hit.path;
  }
  // 常见 USB 转串口厂商
  const prefer = usable.find((p) => /silicon|wch|ch340|ftdi|espressif|cp210|arduino/i.test(
    (p.manufacturer || '') + ' ' + (p.friendlyName || '') + ' ' + (p.vendorId || '')
  ));
  if (prefer) return prefer.path;
  if (usable.length) return usable[0].path;
  throw new Error('没有可用的串口。插上板子了吗？（蓝牙虚拟串口会被跳过）');
}

async function connect() {
  if (DRY) return null;
  let { SerialPort } = require('serialport');
  const path = await pickPort();
  console.log(`连接 ${path} @ ${BAUD} …`);
  return new Promise((resolve, reject) => {
    const p = new SerialPort({ path, baudRate: BAUD, autoOpen: true }, (err) => {
      if (err) reject(err);
      else { console.log('  已连接'); resolve(p); }
    });
    p.on('error', (e) => console.error('  串口错误:', e.message));
    p.on('close', () => { console.log('  串口断开，5 秒后重连…'); port = null; setTimeout(boot, 5000); });
  });
}

async function getData() {
  const r = await fetch(API + '/api/state', { signal: AbortSignal.timeout(5000) });
  return r.json();
}

function buildFrame(st) {
  const lan = (st.urls || []).find((u) => /^http:\/\/(?!127\.|localhost)/.test(u));
  const ip = lan ? lan.replace(/^http:\/\//, '').replace(/:\d+$/, '') : 'no-lan-ip';
  const portTxt = ':' + (lan ? lan.split(':').pop() : '');
  const t = st.totals || {};
  const l2 = `${portTxt}  ${st.status === 'scanning' ? 'SCANNING' : 'READY'}`;
  const l3 = `${fmtSize(t.bytes)} / ${t.folders} dirs`;
  return `F|${ip}|${l2}|${l3}|\n`;
}

async function tick() {
  try {
    const st = await getData();
    const frame = buildFrame(st);
    if (DRY) {
      if (frame !== lastFrame) {
        console.log('将要发送:', JSON.stringify(frame));
        console.log('  屏幕效果:');
        console.log('   ┌────────────────┐');
        console.log('   │ LAN            │');
        frame.split('|').slice(1, 4).forEach((f, i) =>
          console.log('   │ ' + f.padEnd(14).slice(0, 14) + ' │' + (i === 0 ? '  ← 大字号' : '')));
        console.log('   └────────────────┘');
      }
      lastFrame = frame;
      return;
    }
    if (!port) return;
    if (frame === lastFrame) return;          // 内容没变就不刷
    port.write(frame);
    lastFrame = frame;
  } catch (e) {
    if (DRY) {
      // 服务没起也能看到格式
      const fake = { urls: ['http://192.168.1.100:7788'], status: 'ready', totals: { bytes: 927316675954, folders: 114 } };
      const frame = buildFrame(fake);
      if (frame !== lastFrame) { console.log('（服务未启动）将要发送:', JSON.stringify(frame)); lastFrame = frame; }
      return;
    }
    console.error('  取数据失败（服务没启动？）:', e.message);
  }
}

async function boot() {
  try {
    port = await connect();
  } catch (e) {
    console.error('  ' + e.message);
    console.error('  30 秒后重试…（也可以先跑 --dry-run 确认格式）');
    setTimeout(boot, 30000);
    return;
  }
  await tick();
  setInterval(tick, INTERVAL);
}

console.log('照片库 OLED 显示器' + (DRY ? '（dry-run，不连硬件）' : ''));
boot();
