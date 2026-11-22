// armor-main-hook —— 通过 NODE_OPTIONS=--require 注入到 Electron 主进程
//
// 为什么用这条路（本机 fuse 实测）：
//   fuse 串 01 09 '1','0','1','1','0','0','0','0','1','1'
//     [2] EnableNodeOptionsEnvironmentVariable = 1  ← 允许 NODE_OPTIONS
//     [4] EnableEmbeddedAsarIntegrityValidation = 0
// 于是不需要改 app.asar 一个字节，就能在主进程里拿到 electron 模块，
// 再用 webContents.executeJavaScript 把 dock 打进 Hub 页面（内嵌 UI）。
//
// 守门：NODE_OPTIONS 会被所有 node 进程继承，普通 node CLI 直接 return；
// 只有带 process.versions.electron 的进程才真正安装。
'use strict'

;(function () {
  const fs = require('fs')
  const os = require('os')
  const path = require('path')
  const logFile = path.join(os.tmpdir(), 'armor-hud-inject.log')
  const log = (m) => { try { fs.appendFileSync(logFile, new Date().toISOString() + ' [hook] ' + m + '\n') } catch { /* 忽略 */ } }

  try {
    if (!process.versions || !process.versions.electron) return
    log('loaded electron=' + process.versions.electron + ' type=' + process.type)

    const injector = path.join(__dirname, 'armor-hud-inject.cjs')
    if (!fs.existsSync(injector)) { log('injector missing: ' + injector); return }
    require(injector).install()
    log('installed')
  } catch (e) {
    log('HOOK-ERR ' + (e && e.stack ? e.stack.split('\n')[0] : e))
  }
})()
